import * as vscode from 'vscode';
import { ISplitterChatResult, SplitTask, FollowUpActions } from '../types/index.js';
import { LlmService } from '../services/llmService.js';
import { FileService } from '../services/fileService.js';
import { SessionManager } from '../services/sessionManager.js';
import { DiffUtils } from '../utils/diffUtils.js';

/**
 * Creates the main ChatRequestHandler with injected dependencies.
 *
 * This is the orchestration layer — it routes user actions (new query,
 * accept, reject, proceed, skip, stop) and coordinates between services.
 *
 * Dependencies are injected via parameters for easy unit testing.
 */
export function createChatHandler(
    sessionManager: SessionManager,
    llmService: LlmService,
    fileService: FileService,
    diffUtils: DiffUtils
): vscode.ChatRequestHandler {

    // ─── Helper: Build a result object ───────────────────────────────

    function result(
        command: string,
        sessionActive: boolean,
        remainingTasks: number,
        awaitingDecision: boolean = false
    ): ISplitterChatResult {
        return { metadata: { command, sessionActive, remainingTasks, awaitingDecision } };
    }

    // ─── Helper: Process a file-based task ───────────────────────────

    async function processFileTask(
        task: SplitTask,
        model: vscode.LanguageModelChat,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<boolean> {
        const fileName = task.fileName!;

        // Step 1: Find the file in workspace
        stream.progress(`🔍 Searching for "${fileName}" in workspace...`);
        const fileUri = await fileService.findFile(fileName);

        if (!fileUri) {
            stream.markdown(`\n⚠️ **File not found:** Could not find \`${fileName}\` in the workspace.\n\n`);
            stream.markdown(`Please make sure the file exists in your open workspace folders.\n`);
            return false;
        }

        stream.markdown(`📁 **Found:** \`${fileUri.fsPath}\`\n\n`);
        stream.reference(fileUri);

        // Step 2: Read current content
        stream.progress('📖 Reading file content...');
        const originalContent = await fileService.readContent(fileUri);

        // Step 3: Generate changes via LLM
        stream.progress(`🤖 Generating changes for "${fileName}"...`);
        const proposedContent = await llmService.generateFileChanges(
            task.description, fileName, originalContent, model, token
        );

        // Step 4: Open diff editor with green/red highlighting
        const tempFilePath = await diffUtils.openDiffEditor(fileUri, proposedContent, fileName);

        stream.markdown(`\n### 📝 Proposed Changes for \`${fileName}\`\n\n`);
        stream.markdown(`📌 **A diff editor has been opened** showing the proposed changes with highlighted lines.\n\n`);
        stream.markdown(`- 🟢 **Green lines** = additions\n`);
        stream.markdown(`- 🔴 **Red lines** = removals\n\n`);
        stream.markdown(`Review the changes in the editor, then click **Accept** or **Reject** below.\n`);

        // Store pending change for accept/reject
        sessionManager.setPendingChange({
            filePath: fileUri.fsPath,
            originalContent,
            proposedContent,
            tempFilePath
        });

        return true;
    }

    // ─── Helper: Process the current task ────────────────────────────

    async function processCurrentTask(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<ISplitterChatResult> {
        const session = sessionManager.getSession();
        if (!session) {
            return result('error', false, 0);
        }

        const idx = sessionManager.getCurrentIndex();
        const task = sessionManager.getCurrentTask()!;
        const total = sessionManager.getTotalTasks();

        stream.progress(`Processing task ${idx + 1} of ${total}...`);
        stream.markdown(`## 📝 Task ${idx + 1} of ${total}\n`);
        stream.markdown(`**${task.description}**\n\n`);

        if (task.isFileTask && task.fileName) {
            // ── File Task ────────────────────────────────────────
            const hasChanges = await processFileTask(task, request.model, stream, token);

            if (hasChanges) {
                stream.markdown('---\n\n');
                stream.markdown('👆 **Review the proposed changes in the diff editor.** Do you want to apply them?\n');
                return result('file-review', true, total - idx - 1, true);
            } else {
                sessionManager.advanceTask();
                const remaining = sessionManager.getRemainingTasks();
                if (remaining > 0) {
                    stream.markdown('---\n\n');
                    stream.markdown(`📋 **${remaining}** task(s) remaining.\n\n`);
                    stream.markdown(`**Next:** "${sessionManager.getNextTaskDescription()}"\n`);
                    return result('file-not-found', true, remaining);
                } else {
                    stream.markdown('🎉 **All tasks completed!**\n');
                    sessionManager.clearSession();
                    return result('complete', false, 0);
                }
            }
        } else {
            // ── General Query Task ───────────────────────────────
            try {
                await llmService.streamGeneralQuery(task.description, request.model, stream, token);
            } catch (err) {
                stream.markdown(`\n\n⚠️ *Error: ${err}*\n`);
            }

            sessionManager.advanceTask();
            const remaining = sessionManager.getRemainingTasks();

            if (remaining > 0) {
                stream.markdown('\n\n---\n\n');
                stream.markdown(`✅ **Task ${idx + 1} complete!** ${remaining} task(s) remaining.\n\n`);
                stream.markdown(`**Next:** "${sessionManager.getNextTaskDescription()}"\n`);
                return result('query-done', true, remaining);
            } else {
                stream.markdown('\n\n---\n\n');
                stream.markdown('🎉 **All tasks completed!**\n');
                sessionManager.clearSession();
                return result('complete', false, 0);
            }
        }
    }

    // ─── Main Handler ────────────────────────────────────────────────

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<ISplitterChatResult> => {

        const prompt = request.prompt;

        // ─── Detect follow-up actions ────────────────────────────
        const isAccept = prompt.startsWith(FollowUpActions.ACCEPT);
        const isReject = prompt.startsWith(FollowUpActions.REJECT);
        const isProceed = prompt.startsWith(FollowUpActions.PROCEED);
        const isSkip = prompt.startsWith(FollowUpActions.SKIP);
        const isStop = prompt.startsWith(FollowUpActions.STOP);

        // ── STOP ─────────────────────────────────────────────────
        if (isStop && sessionManager.hasSession()) {
            const done = sessionManager.getCurrentIndex();
            const total = sessionManager.getTotalTasks();
            stream.markdown('---\n\n');
            stream.markdown('🛑 **Processing stopped by user.**\n\n');
            stream.markdown(`Completed **${done}** of **${total}** tasks.\n`);
            sessionManager.clearSession();
            return result('stop', false, 0);
        }

        // ── ACCEPT ───────────────────────────────────────────────
        const pendingChange = sessionManager.getPendingChange();
        if (isAccept && pendingChange) {
            try {
                await fileService.applyChange(pendingChange);
                await diffUtils.closeDiffAndCleanup(pendingChange.tempFilePath);
                stream.markdown(`✅ **Changes accepted and applied** to \`${pendingChange.filePath}\`\n\n`);
            } catch (err) {
                stream.markdown(`⚠️ **Failed to apply changes:** ${err}\n\n`);
            }
            sessionManager.clearPendingChange();
            sessionManager.advanceTask();

            const remaining = sessionManager.getRemainingTasks();
            if (remaining > 0) {
                stream.markdown('---\n\n');
                stream.markdown(`📋 **${remaining}** task(s) remaining.\n\n`);
                stream.markdown(`**Next:** "${sessionManager.getNextTaskDescription()}"\n`);
                return result('accepted', true, remaining);
            } else {
                stream.markdown('---\n\n');
                stream.markdown('🎉 **All tasks completed!**\n');
                sessionManager.clearSession();
                return result('complete', false, 0);
            }
        }

        // ── REJECT ───────────────────────────────────────────────
        if (isReject && pendingChange) {
            await diffUtils.closeDiffAndCleanup(pendingChange.tempFilePath);
            stream.markdown(`❌ **Changes rejected** for \`${pendingChange.filePath}\`. File was not modified.\n\n`);
            sessionManager.clearPendingChange();
            sessionManager.advanceTask();

            const remaining = sessionManager.getRemainingTasks();
            if (remaining > 0) {
                stream.markdown('---\n\n');
                stream.markdown(`📋 **${remaining}** task(s) remaining.\n\n`);
                stream.markdown(`**Next:** "${sessionManager.getNextTaskDescription()}"\n`);
                return result('rejected', true, remaining);
            } else {
                stream.markdown('---\n\n');
                stream.markdown('🎉 **All tasks completed!**\n');
                sessionManager.clearSession();
                return result('complete', false, 0);
            }
        }

        // ── PROCEED / SKIP ───────────────────────────────────────
        if ((isProceed || isSkip) && sessionManager.hasSession()) {
            if (isSkip) {
                const task = sessionManager.getCurrentTask();
                stream.markdown(`⏭️ **Skipped:** "${task?.description}"\n\n`);
                sessionManager.advanceTask();
            }

            if (sessionManager.hasMoreTasks()) {
                return await processCurrentTask(request, stream, token);
            } else {
                stream.markdown('🎉 **All tasks completed!**\n');
                sessionManager.clearSession();
                return result('complete', false, 0);
            }
        }

        // ─── New Query (first invocation) ────────────────────────

        if (!prompt.trim()) {
            stream.markdown('Please provide a query. For example:\n\n');
            stream.markdown('> `@splitter Give me top 3 Features of Java and C#`\n\n');
            stream.markdown('> `@splitter Add proper comments in student.cs and teachers.cs`\n');
            return result('empty', false, 0);
        }

        // Step 1: Split the query using LLM
        stream.progress('🔍 Analyzing your query to identify tasks...');

        let tasks: SplitTask[];
        try {
            tasks = await llmService.splitQuery(prompt, request.model, token);
        } catch (err) {
            stream.markdown(`⚠️ Failed to split query: ${err}\n\nProcessing as a single task.\n\n`);
            tasks = [{ description: prompt, isFileTask: false }];
        }

        // Single general query — process directly
        if (tasks.length === 1 && !tasks[0].isFileTask) {
            stream.markdown(`## 📝 Processing Your Query\n\n`);
            try {
                await llmService.streamGeneralQuery(tasks[0].description, request.model, stream, token);
            } catch (err) {
                stream.markdown(`\n\n⚠️ *Error: ${err}*\n`);
            }
            return result('single', false, 0);
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
        sessionManager.startSession(tasks, prompt);

        // Process the first task
        return await processCurrentTask(request, stream, token);
    };

    return handler;
}
