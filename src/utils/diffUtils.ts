import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { FileService } from '../services/fileService.js';

/**
 * Utility functions for managing the VS Code diff editor.
 * Handles opening diffs, closing diff tabs, and temp file cleanup.
 */
export class DiffUtils {

    constructor(private readonly fileService: FileService) { }

    /**
     * Writes proposed content to a temp file and opens the VS Code diff editor
     * to show the changes with green/red highlighting.
     *
     * @param originalUri - URI of the original file
     * @param proposedContent - The proposed new content
     * @param fileName - Display name of the file (for the diff editor title)
     * @returns The temp file path (needed for cleanup later)
     */
    async openDiffEditor(
        originalUri: vscode.Uri,
        proposedContent: string,
        fileName: string
    ): Promise<string> {
        // Create a uniquely-named temp file
        const tempDir = os.tmpdir();
        const tempFileName = `proposed_${Date.now()}_${fileName}`;
        const tempFilePath = path.join(tempDir, tempFileName);
        const tempUri = vscode.Uri.file(tempFilePath);

        // Write proposed content to the temp file
        await this.fileService.writeContent(tempUri, proposedContent);

        // Open the VS Code diff editor — shows green (added) / red (removed)
        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,                                      // left: original file
            tempUri,                                          // right: proposed changes
            `${fileName}: Original ↔ Proposed Changes`,       // diff editor title
            { preview: true }                                 // open as preview tab
        );

        return tempFilePath;
    }

    /**
     * Closes the diff editor tab (if open) and deletes the temp file.
     *
     * @param tempFilePath - Path to the temp file used in the diff
     */
    async closeDiffAndCleanup(tempFilePath: string): Promise<void> {
        const tempUri = vscode.Uri.file(tempFilePath);

        // Find and close the diff tab that references this temp file
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputTextDiff) {
                    if (
                        input.modified.fsPath === tempUri.fsPath ||
                        input.original.fsPath === tempUri.fsPath
                    ) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }
        }

        // Delete the temp file
        await this.fileService.deleteIfExists(tempUri);
    }
}
