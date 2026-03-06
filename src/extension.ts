import * as vscode from 'vscode';
import { LlmService } from './services/llmService.js';
import { FileService } from './services/fileService.js';
import { SessionManager } from './services/sessionManager.js';
import { DiffUtils } from './utils/diffUtils.js';
import { createChatHandler } from './handlers/chatHandler.js';
import { createFollowupProvider } from './handlers/followupProvider.js';

/**
 * Extension entry point.
 *
 * This is a thin activation function that wires up all the services
 * and registers the chat participant. All logic lives in the
 * individual service/handler modules.
 */
export function activate(context: vscode.ExtensionContext) {

    // ── Create Services ──────────────────────────────────────────────

    const llmService = new LlmService();
    const fileService = new FileService();
    const sessionManager = new SessionManager();
    const diffUtils = new DiffUtils(fileService);

    // ── Create Handler ───────────────────────────────────────────────

    const handler = createChatHandler(sessionManager, llmService, fileService, diffUtils);

    // ── Register Chat Participant ────────────────────────────────────

    const splitter = vscode.chat.createChatParticipant('query-splitter.splitter', handler);
    splitter.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

    // ── Wire Follow-up Provider ──────────────────────────────────────

    splitter.followupProvider = createFollowupProvider();

    // ── Register Disposables ─────────────────────────────────────────

    context.subscriptions.push(splitter);
}

export function deactivate() {
    // Nothing to clean up — session state lives in SessionManager
    // which will be garbage collected when the extension deactivates.
}
