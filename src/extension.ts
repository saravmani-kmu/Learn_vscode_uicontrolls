import * as vscode from 'vscode';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionState {
    queries: string[];
    currentIndex: number;
    originalPrompt: string;
}

interface ISplitterChatResult extends vscode.ChatResult {
    metadata: {
        command: string;
        sessionActive: boolean;
        remainingQueries: number;
    };
}

// ─── Session Store ───────────────────────────────────────────────────────────

// We use a single session per extension instance since chat participants
// operate in a single-threaded conversation context.
let currentSession: SessionState | null = null;

// ─── LLM Helpers ─────────────────────────────────────────────────────────────

/**
 * Uses the LLM to split a multi-topic user query into individual sub-queries.
 * Returns a JSON array of strings, each being a self-contained question.
 */
async function splitQueryWithLLM(
    prompt: string,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken
): Promise<string[]> {
    const systemPrompt = `You are a query splitter. Your job is to analyze the user's message and split it into individual, independent sub-queries.

Rules:
1. Each sub-query must be a complete, self-contained question or request.
2. Preserve the user's original intent and detail level for each sub-query.
3. If the query is about multiple topics/subjects (e.g., "Java and C#"), create separate queries for each.
4. If the query cannot be meaningfully split (it's about a single topic), return it as a single-element array.
5. Return ONLY a valid JSON array of strings, nothing else. No markdown, no explanation.

Examples:
- Input: "Give me top 3 Features of Java and C#"
  Output: ["Give me top 3 Features of Java", "Give me top 3 Features of C#"]

- Input: "Explain the difference between REST and GraphQL and also compare SQL vs NoSQL"
  Output: ["Explain the difference between REST and GraphQL", "Compare SQL vs NoSQL"]

- Input: "What is Python?"
  Output: ["What is Python?"]`;

    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(`Split this query: "${prompt}"`)
    ];

    const response = await model.sendRequest(messages, {}, token);

    // Collect the full response text
    let fullResponse = '';
    for await (const fragment of response.text) {
        fullResponse += fragment;
    }

    // Parse the JSON array from the response
    try {
        // Try to extract JSON array from the response (LLM might wrap it in markdown)
        const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((q: unknown) => String(q).trim());
            }
        }
    } catch (e) {
        // If parsing fails, treat the original prompt as a single query
        console.error('Failed to parse LLM split response:', e);
    }

    // Fallback: return original prompt as single query
    return [prompt];
}

/**
 * Sends a single sub-query to the LLM and streams the response to the chat.
 */
async function processSubQuery(
    query: string,
    model: vscode.LanguageModelChat,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    const messages = [
        vscode.LanguageModelChatMessage.User(query)
    ];

    const response = await model.sendRequest(messages, {}, token);

    for await (const fragment of response.text) {
        stream.markdown(fragment);
    }
}

// ─── Extension Activation ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {

    // ── Request Handler ──────────────────────────────────────────────────

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<ISplitterChatResult> => {

        // Check if this is a "proceed" follow-up from an active session
        const isContinuation = request.prompt.startsWith('__SPLITTER_PROCEED__');
        const isSkip = request.prompt.startsWith('__SPLITTER_SKIP__');
        const isStop = request.prompt.startsWith('__SPLITTER_STOP__');

        // ── Handle Stop ──────────────────────────────────────────────
        if (isStop && currentSession) {
            stream.markdown('---\n\n');
            stream.markdown('🛑 **Processing stopped by user.**\n\n');
            stream.markdown(`Completed **${currentSession.currentIndex}** of **${currentSession.queries.length}** queries.\n`);
            currentSession = null;
            return {
                metadata: { command: 'stop', sessionActive: false, remainingQueries: 0 }
            };
        }

        // ── Handle Continue / Skip ───────────────────────────────────
        if ((isContinuation || isSkip) && currentSession) {
            if (isSkip) {
                stream.markdown(`⏭️ **Skipped:** "${currentSession.queries[currentSession.currentIndex]}"\n\n`);
                currentSession.currentIndex++;
            }

            // Process the current sub-query
            if (currentSession.currentIndex < currentSession.queries.length) {
                const queryIndex = currentSession.currentIndex;
                const query = currentSession.queries[queryIndex];
                const total = currentSession.queries.length;

                stream.markdown('---\n\n');
                stream.progress(`Processing query ${queryIndex + 1} of ${total}...`);
                stream.markdown(`## 📝 Query ${queryIndex + 1} of ${total}\n`);
                stream.markdown(`**"${query}"**\n\n`);

                try {
                    await processSubQuery(query, request.model, stream, token);
                } catch (err) {
                    stream.markdown(`\n\n⚠️ *Error processing this query: ${err}*\n`);
                }

                currentSession.currentIndex++;
                const remaining = total - currentSession.currentIndex;

                if (remaining > 0) {
                    stream.markdown('\n\n---\n\n');
                    stream.markdown(`✅ **Query ${queryIndex + 1} complete!** ${remaining} more query(ies) remaining.\n\n`);
                    stream.markdown(`**Next up:** "${currentSession.queries[currentSession.currentIndex]}"\n`);

                    return {
                        metadata: {
                            command: 'proceed',
                            sessionActive: true,
                            remainingQueries: remaining
                        }
                    };
                } else {
                    stream.markdown('\n\n---\n\n');
                    stream.markdown('🎉 **All queries processed!**\n');
                    currentSession = null;

                    return {
                        metadata: { command: 'complete', sessionActive: false, remainingQueries: 0 }
                    };
                }
            }
        }

        // ── Handle New Query (first invocation) ──────────────────────

        const userPrompt = request.prompt;

        if (!userPrompt.trim()) {
            stream.markdown('Please provide a query to split. For example:\n\n');
            stream.markdown('> `@splitter Give me top 3 Features of Java and C#`\n');
            return {
                metadata: { command: 'empty', sessionActive: false, remainingQueries: 0 }
            };
        }

        // Step 1: Split the query using LLM
        stream.progress('🔍 Analyzing your query to identify sub-topics...');

        let queries: string[];
        try {
            queries = await splitQueryWithLLM(userPrompt, request.model, token);
        } catch (err) {
            stream.markdown(`⚠️ Failed to split query: ${err}\n\nProcessing as a single query instead.\n\n`);
            queries = [userPrompt];
        }

        // Step 2: Show the split results
        if (queries.length === 1) {
            // Single query — process directly without the loop
            stream.markdown(`## 📝 Processing Your Query\n\n`);
            stream.markdown(`Your query is about a single topic. Processing directly...\n\n`);
            stream.markdown('---\n\n');

            try {
                await processSubQuery(queries[0], request.model, stream, token);
            } catch (err) {
                stream.markdown(`\n\n⚠️ *Error processing query: ${err}*\n`);
            }

            return {
                metadata: { command: 'single', sessionActive: false, remainingQueries: 0 }
            };
        }

        // Multiple queries — start the interactive session
        stream.markdown(`## 🔀 Query Split Results\n\n`);
        stream.markdown(`I identified **${queries.length} sub-queries** from your message:\n\n`);
        queries.forEach((q, i) => {
            stream.markdown(`${i + 1}. "${q}"\n`);
        });
        stream.markdown('\n---\n\n');

        // Initialize session state
        currentSession = {
            queries: queries,
            currentIndex: 0,
            originalPrompt: userPrompt
        };

        // Process the first query immediately
        const firstQuery = queries[0];
        stream.progress('Processing query 1...');
        stream.markdown(`## 📝 Query 1 of ${queries.length}\n`);
        stream.markdown(`**"${firstQuery}"**\n\n`);

        try {
            await processSubQuery(firstQuery, request.model, stream, token);
        } catch (err) {
            stream.markdown(`\n\n⚠️ *Error processing this query: ${err}*\n`);
        }

        currentSession.currentIndex = 1;
        const remaining = queries.length - 1;

        stream.markdown('\n\n---\n\n');
        stream.markdown(`✅ **Query 1 complete!** ${remaining} more query(ies) remaining.\n\n`);
        stream.markdown(`**Next up:** "${queries[1]}"\n`);

        return {
            metadata: {
                command: 'split',
                sessionActive: true,
                remainingQueries: remaining
            }
        };
    };

    // ── Create Chat Participant ──────────────────────────────────────────

    const splitter = vscode.chat.createChatParticipant('query-splitter.splitter', handler);
    splitter.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

    // ── Follow-up Provider ───────────────────────────────────────────────

    splitter.followupProvider = {
        provideFollowups(
            result: ISplitterChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken
        ): vscode.ChatFollowup[] {
            if (result.metadata.sessionActive && result.metadata.remainingQueries > 0) {
                return [
                    {
                        prompt: '__SPLITTER_PROCEED__',
                        label: `✅ Yes, Proceed to next query (${result.metadata.remainingQueries} remaining)`,
                        command: 'split'
                    },
                    {
                        prompt: '__SPLITTER_SKIP__',
                        label: '⏭️ Skip this & proceed to next',
                        command: 'split'
                    },
                    {
                        prompt: '__SPLITTER_STOP__',
                        label: '❌ Stop here',
                        command: 'split'
                    }
                ];
            }
            return [];
        }
    };

    // ── Disposables ──────────────────────────────────────────────────────

    context.subscriptions.push(splitter);
}

export function deactivate() {
    // Clean up session state
    currentSession = null;
}
