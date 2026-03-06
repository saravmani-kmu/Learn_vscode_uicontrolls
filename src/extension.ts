import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Represents a single task identified by the LLM splitter.
 * Can be a general knowledge query OR a file-based task.
 */
interface SplitTask {
    description: string;   // The full task description (e.g., "Add proper comments in student.cs")
    fileName?: string;     // If file-based, the filename to find (e.g., "student.cs")
    isFileTask: boolean;   // Whether this task involves modifying a file
}

/**
 * Tracks the current state of the multi-task session.
 */
interface SessionState {
    tasks: SplitTask[];
    currentIndex: number;
    originalPrompt: string;
    /** For file tasks: stores proposed new content awaiting accept/reject */
    pendingFileChange?: {
        filePath: string;
        originalContent: string;
        proposedContent: string;
        tempFilePath: string;  // path to the temp file used in diff editor
    };
    /** Current phase in the flow: 'reviewing' = showing changes, 'decided' = accepted/rejected */
    phase: 'processing' | 'reviewing' | 'decided';
}

interface ISplitterChatResult extends vscode.ChatResult {
    metadata: {
        command: string;
        sessionActive: boolean;
        remainingTasks: number;
        awaitingDecision: boolean;  // true when waiting for accept/reject
    };
}

// ─── Session Store ───────────────────────────────────────────────────────────

let currentSession: SessionState | null = null;

// ─── LLM Helpers ─────────────────────────────────────────────────────────────

/**
 * Uses the LLM to split a user query into individual tasks.
 * Detects whether each task involves a file (returns structured JSON).
 */
async function splitQueryWithLLM(
    prompt: string,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken
): Promise<SplitTask[]> {
    const systemPrompt = `You are a task splitter. Analyze the user's message and split it into individual, independent tasks.

Rules:
1. Each task must be self-contained with the full intent preserved.
2. If the query mentions multiple files (e.g., "student.cs and teachers.cs"), create a separate task for EACH file.
3. If the query mentions multiple topics/subjects (e.g., "Java and C#"), create separate tasks for each.
4. Detect if a task involves modifying a file — look for filenames with extensions like .cs, .ts, .js, .py, .java, etc.
5. Return ONLY a valid JSON array. No markdown, no explanation.

JSON format for each task:
{
  "description": "the full task description",
  "fileName": "filename.ext or null if not a file task",
  "isFileTask": true/false
}

Examples:
- Input: "Add proper comments in below files - student.cs and teachers.cs"
  Output: [{"description":"Add proper comments in student.cs","fileName":"student.cs","isFileTask":true},{"description":"Add proper comments in teachers.cs","fileName":"teachers.cs","isFileTask":true}]

- Input: "Give me top 3 Features of Java and C#"
  Output: [{"description":"Give me top 3 Features of Java","fileName":null,"isFileTask":false},{"description":"Give me top 3 Features of C#","fileName":null,"isFileTask":false}]

- Input: "Refactor the login method in auth.ts"
  Output: [{"description":"Refactor the login method in auth.ts","fileName":"auth.ts","isFileTask":true}]`;

    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(`Split this: "${prompt}"`)
    ];

    const response = await model.sendRequest(messages, {}, token);

    let fullResponse = '';
    for await (const fragment of response.text) {
        fullResponse += fragment;
    }

    try {
        const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((t: any) => ({
                    description: String(t.description || '').trim(),
                    fileName: t.fileName && t.fileName !== 'null' ? String(t.fileName).trim() : undefined,
                    isFileTask: Boolean(t.isFileTask)
                }));
            }
        }
    } catch (e) {
        console.error('Failed to parse LLM split response:', e);
    }

    // Fallback: single non-file task
    return [{ description: prompt, isFileTask: false }];
}

/**
 * Searches the workspace for a file by name.
 * Returns the URI of the first match, or undefined.
 */
async function findFileInWorkspace(fileName: string): Promise<vscode.Uri | undefined> {
    const files = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 5);
    return files.length > 0 ? files[0] : undefined;
}

/**
 * Reads the full content of a file.
 */
async function readFileContent(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf-8');
}

/**
 * Uses the LLM to generate the modified file content for a file task.
 * Returns the full proposed new content of the file.
 */
async function generateFileChanges(
    taskDescription: string,
    fileName: string,
    fileContent: string,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken
): Promise<string> {
    const systemPrompt = `You are a code assistant. The user wants you to modify a file.
Your task: ${taskDescription}

RULES:
1. Return the COMPLETE modified file content — every line, not just the changed parts.
2. Do NOT wrap the output in markdown code fences or add any commentary.
3. Only return the raw file content, ready to be saved directly.
4. Preserve the original file structure, indentation, and formatting.
5. Apply the requested changes carefully and thoroughly.`;

    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(`Here is the current content of "${fileName}":\n\n${fileContent}`)
    ];

    const response = await model.sendRequest(messages, {}, token);

    let result = '';
    for await (const fragment of response.text) {
        result += fragment;
    }

    // Strip markdown code fences if the LLM added them despite instructions
    result = result.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '');

    return result;
}

/**
 * Sends a general (non-file) query to the LLM and streams the response.
 */
async function processGeneralQuery(
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

/**
 * Processes a file-based task: finds the file, generates changes, opens diff editor.
 * Returns true if changes were proposed (awaiting accept/reject), false otherwise.
 */
async function processFileTask(
    task: SplitTask,
    model: vscode.LanguageModelChat,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<boolean> {
    const fileName = task.fileName!;

    // Step 1: Find the file in workspace
    stream.progress(`🔍 Searching for "${fileName}" in workspace...`);
    const fileUri = await findFileInWorkspace(fileName);

    if (!fileUri) {
        stream.markdown(`\n⚠️ **File not found:** Could not find \`${fileName}\` in the workspace.\n\n`);
        stream.markdown(`Please make sure the file exists in your open workspace folders.\n`);
        return false;
    }

    stream.markdown(`📁 **Found:** \`${fileUri.fsPath}\`\n\n`);
    stream.reference(fileUri);

    // Step 2: Read current content
    stream.progress('📖 Reading file content...');
    const originalContent = await readFileContent(fileUri);

    // Step 3: Generate changes via LLM
    stream.progress(`🤖 Generating changes for "${fileName}"...`);
    const proposedContent = await generateFileChanges(
        task.description, fileName, originalContent, model, token
    );

    // Step 4: Write proposed content to a temp file and open the diff editor
    const tempDir = os.tmpdir();
    const tempFileName = `proposed_${Date.now()}_${fileName}`;
    const tempFilePath = path.join(tempDir, tempFileName);
    const tempUri = vscode.Uri.file(tempFilePath);

    // Write proposed content to temp file
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tempUri, encoder.encode(proposedContent));

    // Open the VS Code diff editor — shows green (added) / red (removed) highlighting
    await vscode.commands.executeCommand(
        'vscode.diff',
        fileUri,                                          // left: original file
        tempUri,                                          // right: proposed changes
        `${fileName}: Original ↔ Proposed Changes`,       // diff editor title
        { preview: true }                                 // open as preview tab
    );

    stream.markdown(`\n### 📝 Proposed Changes for \`${fileName}\`\n\n`);
    stream.markdown(`📌 **A diff editor has been opened** showing the proposed changes with highlighted lines.\n\n`);
    stream.markdown(`- 🟢 **Green lines** = additions\n`);
    stream.markdown(`- 🔴 **Red lines** = removals\n\n`);
    stream.markdown(`Review the changes in the editor, then click **Accept** or **Reject** below.\n`);

    // Store pending change in session for accept/reject
    if (currentSession) {
        currentSession.pendingFileChange = {
            filePath: fileUri.fsPath,
            originalContent: originalContent,
            proposedContent: proposedContent,
            tempFilePath: tempFilePath
        };
        currentSession.phase = 'reviewing';
    }

    return true;
}

/**
 * Applies the pending file change by writing the proposed content to the original file.
 * Also closes the diff editor tab and cleans up the temp file.
 */
async function applyFileChange(change: NonNullable<SessionState['pendingFileChange']>): Promise<void> {
    const uri = vscode.Uri.file(change.filePath);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(change.proposedContent));

    // Close the diff editor tab and clean up temp file
    await closeDiffAndCleanup(change.tempFilePath);
}

/**
 * Closes the diff editor tab (if open) and deletes the temp file.
 */
async function closeDiffAndCleanup(tempFilePath: string): Promise<void> {
    // Close any tab whose URI matches the temp file
    const tempUri = vscode.Uri.file(tempFilePath);
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            // Diff tabs have input type TabInputTextDiff
            const input = tab.input;
            if (input instanceof vscode.TabInputTextDiff) {
                if (input.modified.fsPath === tempUri.fsPath || input.original.fsPath === tempUri.fsPath) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
    }

    // Delete the temp file
    try {
        await vscode.workspace.fs.delete(tempUri);
    } catch {
        // Ignore if already deleted
    }
}


// ─── Extension Activation ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {

    // ── Request Handler ──────────────────────────────────────────────────

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<ISplitterChatResult> => {

        const prompt = request.prompt;

        // ─── Follow-up Actions ───────────────────────────────────────
        const isAccept = prompt.startsWith('__SPLITTER_ACCEPT__');
        const isReject = prompt.startsWith('__SPLITTER_REJECT__');
        const isProceed = prompt.startsWith('__SPLITTER_PROCEED__');
        const isSkip = prompt.startsWith('__SPLITTER_SKIP__');
        const isStop = prompt.startsWith('__SPLITTER_STOP__');

        // ── Handle STOP ──────────────────────────────────────────────
        if (isStop && currentSession) {
            const done = currentSession.currentIndex;
            const total = currentSession.tasks.length;
            stream.markdown('---\n\n');
            stream.markdown('🛑 **Processing stopped by user.**\n\n');
            stream.markdown(`Completed **${done}** of **${total}** tasks.\n`);
            currentSession = null;
            return { metadata: { command: 'stop', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
        }

        // ── Handle ACCEPT changes ────────────────────────────────────
        if (isAccept && currentSession?.pendingFileChange) {
            try {
                await applyFileChange(currentSession.pendingFileChange);
                stream.markdown(`✅ **Changes accepted and applied** to \`${currentSession.pendingFileChange.filePath}\`\n\n`);
            } catch (err) {
                stream.markdown(`⚠️ **Failed to apply changes:** ${err}\n\n`);
            }
            currentSession.pendingFileChange = undefined;
            currentSession.phase = 'decided';
            currentSession.currentIndex++;

            const remaining = currentSession.tasks.length - currentSession.currentIndex;
            if (remaining > 0) {
                stream.markdown('---\n\n');
                stream.markdown(`📋 **${remaining}** task(s) remaining.\n\n`);
                stream.markdown(`**Next:** "${currentSession.tasks[currentSession.currentIndex].description}"\n`);
                return { metadata: { command: 'accepted', sessionActive: true, remainingTasks: remaining, awaitingDecision: false } };
            } else {
                stream.markdown('---\n\n');
                stream.markdown('🎉 **All tasks completed!**\n');
                currentSession = null;
                return { metadata: { command: 'complete', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
            }
        }

        // ── Handle REJECT changes ────────────────────────────────────
        if (isReject && currentSession?.pendingFileChange) {
            // Close the diff editor and clean up temp file
            await closeDiffAndCleanup(currentSession.pendingFileChange.tempFilePath);

            stream.markdown(`❌ **Changes rejected** for \`${currentSession.pendingFileChange.filePath}\`. File was not modified.\n\n`);
            currentSession.pendingFileChange = undefined;
            currentSession.phase = 'decided';
            currentSession.currentIndex++;

            const remaining = currentSession.tasks.length - currentSession.currentIndex;
            if (remaining > 0) {
                stream.markdown('---\n\n');
                stream.markdown(`📋 **${remaining}** task(s) remaining.\n\n`);
                stream.markdown(`**Next:** "${currentSession.tasks[currentSession.currentIndex].description}"\n`);
                return { metadata: { command: 'rejected', sessionActive: true, remainingTasks: remaining, awaitingDecision: false } };
            } else {
                stream.markdown('---\n\n');
                stream.markdown('🎉 **All tasks completed!**\n');
                currentSession = null;
                return { metadata: { command: 'complete', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
            }
        }

        // ── Handle PROCEED to next task ──────────────────────────────
        if ((isProceed || isSkip) && currentSession) {
            if (isSkip) {
                stream.markdown(`⏭️ **Skipped:** "${currentSession.tasks[currentSession.currentIndex].description}"\n\n`);
                currentSession.currentIndex++;
            }

            if (currentSession.currentIndex < currentSession.tasks.length) {
                return await processCurrentTask(request, stream, token);
            } else {
                stream.markdown('🎉 **All tasks completed!**\n');
                currentSession = null;
                return { metadata: { command: 'complete', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
            }
        }

        // ─── New Query (First Invocation) ────────────────────────────

        if (!prompt.trim()) {
            stream.markdown('Please provide a query. For example:\n\n');
            stream.markdown('> `@splitter Give me top 3 Features of Java and C#`\n\n');
            stream.markdown('> `@splitter Add proper comments in student.cs and teachers.cs`\n');
            return { metadata: { command: 'empty', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
        }

        // Step 1: Split the query using LLM
        stream.progress('🔍 Analyzing your query to identify tasks...');

        let tasks: SplitTask[];
        try {
            tasks = await splitQueryWithLLM(prompt, request.model, token);
        } catch (err) {
            stream.markdown(`⚠️ Failed to split query: ${err}\n\nProcessing as a single task.\n\n`);
            tasks = [{ description: prompt, isFileTask: false }];
        }

        // Step 2: Show the split results
        if (tasks.length === 1 && !tasks[0].isFileTask) {
            // Single general query — process directly
            stream.markdown(`## 📝 Processing Your Query\n\n`);
            try {
                await processGeneralQuery(tasks[0].description, request.model, stream, token);
            } catch (err) {
                stream.markdown(`\n\n⚠️ *Error: ${err}*\n`);
            }
            return { metadata: { command: 'single', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
        }

        // Multiple tasks — show summary and start interactive session
        stream.markdown(`## 🔀 Task Split Results\n\n`);
        stream.markdown(`I identified **${tasks.length} task(s)** from your message:\n\n`);
        tasks.forEach((t, i) => {
            const icon = t.isFileTask ? '📄' : '💬';
            stream.markdown(`${i + 1}. ${icon} ${t.description}${t.fileName ? ` (\`${t.fileName}\`)` : ''}\n`);
        });
        stream.markdown('\n---\n\n');

        // Initialize session
        currentSession = {
            tasks: tasks,
            currentIndex: 0,
            originalPrompt: prompt,
            phase: 'processing'
        };

        // Process the first task
        return await processCurrentTask(request, stream, token);
    };

    /**
     * Processes the task at currentSession.currentIndex.
     * Handles both file-based and general query tasks.
     */
    async function processCurrentTask(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<ISplitterChatResult> {

        if (!currentSession) {
            return { metadata: { command: 'error', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
        }

        const idx = currentSession.currentIndex;
        const task = currentSession.tasks[idx];
        const total = currentSession.tasks.length;

        stream.progress(`Processing task ${idx + 1} of ${total}...`);
        stream.markdown(`## 📝 Task ${idx + 1} of ${total}\n`);
        stream.markdown(`**${task.description}**\n\n`);

        if (task.isFileTask && task.fileName) {
            // ── File Task ────────────────────────────────────────────
            const hasChanges = await processFileTask(task, request.model, stream, token);

            if (hasChanges) {
                // Waiting for accept/reject
                stream.markdown('---\n\n');
                stream.markdown('👆 **Review the proposed changes above.** Do you want to apply them?\n');

                return {
                    metadata: {
                        command: 'file-review',
                        sessionActive: true,
                        remainingTasks: total - idx - 1,
                        awaitingDecision: true
                    }
                };
            } else {
                // File not found or error — move on
                currentSession.currentIndex++;
                const remaining = total - currentSession.currentIndex;

                if (remaining > 0) {
                    stream.markdown('---\n\n');
                    stream.markdown(`📋 **${remaining}** task(s) remaining.\n\n`);
                    stream.markdown(`**Next:** "${currentSession.tasks[currentSession.currentIndex].description}"\n`);
                    return { metadata: { command: 'file-not-found', sessionActive: true, remainingTasks: remaining, awaitingDecision: false } };
                } else {
                    stream.markdown('🎉 **All tasks completed!**\n');
                    currentSession = null;
                    return { metadata: { command: 'complete', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
                }
            }
        } else {
            // ── General Query Task ───────────────────────────────────
            try {
                await processGeneralQuery(task.description, request.model, stream, token);
            } catch (err) {
                stream.markdown(`\n\n⚠️ *Error: ${err}*\n`);
            }

            currentSession.currentIndex++;
            const remaining = total - currentSession.currentIndex;

            if (remaining > 0) {
                stream.markdown('\n\n---\n\n');
                stream.markdown(`✅ **Task ${idx + 1} complete!** ${remaining} task(s) remaining.\n\n`);
                stream.markdown(`**Next:** "${currentSession.tasks[currentSession.currentIndex].description}"\n`);
                return { metadata: { command: 'query-done', sessionActive: true, remainingTasks: remaining, awaitingDecision: false } };
            } else {
                stream.markdown('\n\n---\n\n');
                stream.markdown('🎉 **All tasks completed!**\n');
                currentSession = null;
                return { metadata: { command: 'complete', sessionActive: false, remainingTasks: 0, awaitingDecision: false } };
            }
        }
    }

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

            // Case 1: Awaiting accept/reject decision on file changes
            if (result.metadata.awaitingDecision) {
                return [
                    {
                        prompt: '__SPLITTER_ACCEPT__',
                        label: '✅ Accept Changes',
                        command: 'split'
                    },
                    {
                        prompt: '__SPLITTER_REJECT__',
                        label: '❌ Reject Changes',
                        command: 'split'
                    }
                ];
            }

            // Case 2: Task done, more tasks remain — ask "Should I proceed?"
            if (result.metadata.sessionActive && result.metadata.remainingTasks > 0) {
                return [
                    {
                        prompt: '__SPLITTER_PROCEED__',
                        label: `▶️ Yes, Proceed to next task (${result.metadata.remainingTasks} remaining)`,
                        command: 'split'
                    },
                    {
                        prompt: '__SPLITTER_SKIP__',
                        label: '⏭️ Skip next & proceed',
                        command: 'split'
                    },
                    {
                        prompt: '__SPLITTER_STOP__',
                        label: '⏹️ Stop here',
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
    currentSession = null;
}
