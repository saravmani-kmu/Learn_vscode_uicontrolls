import * as vscode from 'vscode';
import { SplitTask } from '../types/index.js';

/**
 * Service responsible for all LLM interactions.
 * Wraps the VS Code Language Model API for testability —
 * in unit tests, you can mock this entire class.
 */
export class LlmService {

    /**
     * Uses the LLM to split a user query into individual tasks.
     * Detects whether each task involves a file (returns structured JSON).
     */
    async splitQuery(
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
     * Uses the LLM to generate the modified file content for a file task.
     * Returns the full proposed new content of the file.
     */
    async generateFileChanges(
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
     * Sends a general (non-file) query to the LLM and streams the response
     * to the chat response stream.
     */
    async streamGeneralQuery(
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
}
