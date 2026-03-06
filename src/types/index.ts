import * as vscode from 'vscode';

// ─── Split Task ──────────────────────────────────────────────────────────────

/**
 * Represents a single task identified by the LLM splitter.
 * Can be a general knowledge query OR a file-based task.
 */
export interface SplitTask {
    /** The full task description (e.g., "Add proper comments in student.cs") */
    description: string;
    /** If file-based, the filename to find (e.g., "student.cs") */
    fileName?: string;
    /** Whether this task involves modifying a file */
    isFileTask: boolean;
}

// ─── Pending File Change ─────────────────────────────────────────────────────

/**
 * Stores proposed file changes while awaiting user accept/reject.
 */
export interface PendingFileChange {
    filePath: string;
    originalContent: string;
    proposedContent: string;
    /** Path to the temp file used in the diff editor */
    tempFilePath: string;
}

// ─── Session State ───────────────────────────────────────────────────────────

/**
 * Tracks the current state of a multi-task session.
 */
export interface SessionState {
    tasks: SplitTask[];
    currentIndex: number;
    originalPrompt: string;
    /** For file tasks: stores proposed new content awaiting accept/reject */
    pendingFileChange?: PendingFileChange;
    /** Current phase in the flow */
    phase: 'processing' | 'reviewing' | 'decided';
}

// ─── Chat Result ─────────────────────────────────────────────────────────────

/**
 * Metadata returned by the chat handler after processing a request.
 * Used by the follow-up provider to decide which buttons to show.
 */
export interface ISplitterChatResult extends vscode.ChatResult {
    metadata: {
        command: string;
        sessionActive: boolean;
        remainingTasks: number;
        /** true when waiting for accept/reject decision on file changes */
        awaitingDecision: boolean;
    };
}

// ─── Follow-up Action Constants ──────────────────────────────────────────────

/**
 * Special prompt prefixes used by follow-up buttons to signal actions.
 * These are sent as the prompt text when the user clicks a follow-up button.
 */
export const FollowUpActions = {
    ACCEPT: '__SPLITTER_ACCEPT__',
    REJECT: '__SPLITTER_REJECT__',
    PROCEED: '__SPLITTER_PROCEED__',
    SKIP: '__SPLITTER_SKIP__',
    STOP: '__SPLITTER_STOP__',
} as const;
