import * as vscode from 'vscode';
import { ISplitterChatResult, FollowUpActions } from '../types/index.js';

/**
 * Creates a ChatFollowupProvider that shows appropriate buttons
 * based on the current session state.
 *
 * Separated from the main handler for clarity and testability.
 */
export function createFollowupProvider(): vscode.ChatFollowupProvider {
    return {
        provideFollowups(
            result: ISplitterChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken
        ): vscode.ChatFollowup[] {

            // Case 1: Awaiting accept/reject decision on file changes
            if (result.metadata.awaitingDecision) {
                return [
                    {
                        prompt: FollowUpActions.ACCEPT,
                        label: '✅ Accept Changes',
                        command: 'split'
                    },
                    {
                        prompt: FollowUpActions.REJECT,
                        label: '❌ Reject Changes',
                        command: 'split'
                    }
                ];
            }

            // Case 2: Task done, more tasks remain — ask "Should I proceed?"
            if (result.metadata.sessionActive && result.metadata.remainingTasks > 0) {
                return [
                    {
                        prompt: FollowUpActions.PROCEED,
                        label: `▶️ Yes, Proceed to next task (${result.metadata.remainingTasks} remaining)`,
                        command: 'split'
                    },
                    {
                        prompt: FollowUpActions.SKIP,
                        label: '⏭️ Skip next & proceed',
                        command: 'split'
                    },
                    {
                        prompt: FollowUpActions.STOP,
                        label: '⏹️ Stop here',
                        command: 'split'
                    }
                ];
            }

            return [];
        }
    };
}
