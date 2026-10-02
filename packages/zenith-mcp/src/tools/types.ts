type ToolTextContent = {
    type: "text";
    text: string;
};

type ToolImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};

type ToolAudioContent = {
    type: "audio";
    data: string;
    mimeType: string;
};

type ToolBlobContent = {
    type: "blob";
    data: string;
    mimeType: string;
};

type ToolContent = ToolTextContent | ToolImageContent | ToolAudioContent | ToolBlobContent;

type ToolResult = {
    content: ToolContent[];
};

/** Per-call context the transport hands over with the arguments (the SDK's `extra`). */
export type ToolCallExtra = {
    /** Aborted when the client cancels the request. */
    signal?: AbortSignal;
};

type ToolHandler<TArgs> = (args: TArgs, extra?: ToolCallExtra) => Promise<ToolResult> | ToolResult;

type ToolRegistration = {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: {
        readOnlyHint?: boolean;
        idempotentHint?: boolean;
        destructiveHint?: boolean;
    };
};

export type ToolServer = {
    registerTool<TArgs>(
        name: string,
        registration: ToolRegistration,
        handler: ToolHandler<TArgs>
    ): void;
};

export type ToolContext = {
    sessionId?: string;
    validatePath(inputPath: string): Promise<string>;
    validateNewFilePath(inputPath: string): Promise<string>;
    getAllowedDirectories: () => string[];
    setAllowedDirectories: (directories: string[]) => void;
    // Optional: real FilesystemContext implements this; lightweight test mocks
    // may omit it. registerEnabledTools wires the `sandbox` config flag through
    // it, so enforcement is opt-in rather than implied by allowed-dir presence.
    setSandboxEnabled?: (enabled: boolean) => void;
};

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
