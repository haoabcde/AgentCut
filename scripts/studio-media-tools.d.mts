export interface StudioMediaTools {
  ffmpegPath?: string;
  ffprobePath?: string;
}

export function resolveStudioMediaTools(
  env?: Record<string, string | undefined>,
  fileExists?: (path: string) => boolean,
): StudioMediaTools;
