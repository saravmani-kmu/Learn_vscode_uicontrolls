import { SplitTask, SessionState, PendingFileChange } from '../types/index.js';

/**
 * Manages the multi-task session state.
 * Encapsulates session lifecycle instead of using a module-level variable.
 * In unit tests, you can create a fresh SessionManager for each test.
 */
export class SessionManager {

    private currentSession: SessionState | null = null;

    /**
     * Returns the current active session, or null if none.
     */
    getSession(): SessionState | null {
        return this.currentSession;
    }

    /**
     * Returns true if there is an active session.
     */
    hasSession(): boolean {
        return this.currentSession !== null;
    }

    /**
     * Starts a new session with the given tasks.
     *
     * @param tasks - The list of split tasks to process
     * @param originalPrompt - The user's original prompt
     * @returns The newly created session
     */
    startSession(tasks: SplitTask[], originalPrompt: string): SessionState {
        this.currentSession = {
            tasks,
            currentIndex: 0,
            originalPrompt,
            phase: 'processing'
        };
        return this.currentSession;
    }

    /**
     * Clears the current session (e.g., when all tasks are done or user stops).
     */
    clearSession(): void {
        this.currentSession = null;
    }

    /**
     * Returns the current task being processed, or undefined if no session
     * or all tasks are done.
     */
    getCurrentTask(): SplitTask | undefined {
        if (!this.currentSession) { return undefined; }
        return this.currentSession.tasks[this.currentSession.currentIndex];
    }

    /**
     * Returns the current task index (0-based).
     */
    getCurrentIndex(): number {
        return this.currentSession?.currentIndex ?? 0;
    }

    /**
     * Returns the total number of tasks in the session.
     */
    getTotalTasks(): number {
        return this.currentSession?.tasks.length ?? 0;
    }

    /**
     * Returns the number of remaining tasks after the current one.
     */
    getRemainingTasks(): number {
        if (!this.currentSession) { return 0; }
        return this.currentSession.tasks.length - this.currentSession.currentIndex;
    }

    /**
     * Advances to the next task by incrementing the current index.
     */
    advanceTask(): void {
        if (this.currentSession) {
            this.currentSession.currentIndex++;
        }
    }

    /**
     * Returns true if there are more tasks to process.
     */
    hasMoreTasks(): boolean {
        if (!this.currentSession) { return false; }
        return this.currentSession.currentIndex < this.currentSession.tasks.length;
    }

    /**
     * Returns the next task description (after the current one), or undefined.
     */
    getNextTaskDescription(): string | undefined {
        if (!this.currentSession) { return undefined; }
        const nextIdx = this.currentSession.currentIndex;
        if (nextIdx < this.currentSession.tasks.length) {
            return this.currentSession.tasks[nextIdx].description;
        }
        return undefined;
    }

    // ─── Pending File Change ─────────────────────────────────────────

    /**
     * Sets a pending file change for the current task.
     */
    setPendingChange(change: PendingFileChange): void {
        if (this.currentSession) {
            this.currentSession.pendingFileChange = change;
            this.currentSession.phase = 'reviewing';
        }
    }

    /**
     * Returns the pending file change, or undefined if none.
     */
    getPendingChange(): PendingFileChange | undefined {
        return this.currentSession?.pendingFileChange;
    }

    /**
     * Clears the pending file change and marks the phase as 'decided'.
     */
    clearPendingChange(): void {
        if (this.currentSession) {
            this.currentSession.pendingFileChange = undefined;
            this.currentSession.phase = 'decided';
        }
    }
}
