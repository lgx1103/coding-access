/** Electron adds an IPC implementation prefix to errors received from the main process. */
export function userErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '操作失败，请稍后重试';
  return message.replace(/^Error invoking remote method ['"]coding-access:[^'"]+['"]:\s*(?:Error:\s*)?/, '');
}
