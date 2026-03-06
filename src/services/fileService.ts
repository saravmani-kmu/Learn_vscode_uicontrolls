import * as vscode from 'vscode';
import { PendingFileChange } from '../types/index.js';

/**
 * Service responsible for all file system operations.
 * Wraps the VS Code workspace.fs API for testability —
 * in unit tests, you can mock this entire class.
 */
export class FileService {

    /**
     * Searches the workspace for a file by name.
     * Returns the URI of the first match, or undefined if not found.
     *
     * @param fileName - The filename to search for (e.g., "student.cs")
     * @returns The URI of the first matching file, or undefined
     */
    async findFile(fileName: string): Promise<vscode.Uri | undefined> {
        const files = await vscode.workspace.findFiles(
            `**/${fileName}`,       // Search in all directories
            '**/node_modules/**',   // Skip node_modules
            5                       // Max 5 results
        );
        return files.length > 0 ? files[0] : undefined;
    }

    /**
     * Reads the full content of a file as a UTF-8 string.
     *
     * @param uri - The URI of the file to read
     * @returns The file content as a string
     */
    async readContent(uri: vscode.Uri): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf-8');
    }

    /**
     * Writes string content to a file, creating or overwriting it.
     *
     * @param uri - The URI of the file to write
     * @param content - The string content to write
     */
    async writeContent(uri: vscode.Uri, content: string): Promise<void> {
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    }

    /**
     * Applies a pending file change by writing the proposed content
     * to the original file.
     *
     * @param change - The pending file change to apply
     */
    async applyChange(change: PendingFileChange): Promise<void> {
        const uri = vscode.Uri.file(change.filePath);
        await this.writeContent(uri, change.proposedContent);
    }

    /**
     * Deletes a file if it exists. Silently ignores errors.
     *
     * @param uri - The URI of the file to delete
     */
    async deleteIfExists(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.delete(uri);
        } catch {
            // Ignore if already deleted
        }
    }
}
