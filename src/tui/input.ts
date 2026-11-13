/** Wait for terminal input, rejecting on EOF/disconnect and always removing listeners. */
export function readTerminalInput<T>(
  onData: (chunk: Buffer, finish: (result: T) => void) => void,
): Promise<T> {
  const stdin = process.stdin;
  return new Promise<T>((resolve, reject) => {
    function cleanup(): void {
      stdin.off("data", onChunk);
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      stdin.off("error", onError);
    }
    function finish(result: T): void {
      cleanup();
      resolve(result);
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onEnd(): void {
      onError(
        new Error("Terminal input ended before a choice was made. Use explicit command arguments."),
      );
    }
    function onChunk(chunk: Buffer): void {
      try {
        onData(chunk, finish);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    stdin.on("data", onChunk);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.once("error", onError);
    if (stdin.readableEnded || stdin.destroyed) onEnd();
  });
}
