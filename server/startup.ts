const safeErrors = new Map([
  [
    'Set JELLYPORT_ADMIN_PASSWORD to a strong password of 12–512 characters before starting Jellyport.',
    'Remove JELLYPORT_ADMIN_PASSWORD to use the generated setup code, or set this optional one-time upgrade password to 12–512 characters and replace the example value.',
  ],
  [
    'The Jellyport database has no encryption key. Restore secret.key from the same backup.',
    'The existing database is missing its encryption key. Restore secret.key and the database from the same backup; do not generate a replacement key.',
  ],
  [
    'Invalid Jellyport encryption key. Restore the original secret.key from backup.',
    'The encryption key is invalid. Restore the original secret.key from backup.',
  ],
  [
    'Saved Jellyport secrets could not be decrypted. Restore the matching database and secret.key.',
    'Saved secrets could not be decrypted. Restore the matching database and secret.key from backup.',
  ],
]);

/** Startup errors can contain file paths or secrets. Return only fixed, allowlisted diagnostics. */
export function startupFailureDetail(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied. Make the mounted data directory and its existing database, journal files and secret.key owned by the configured container user and group.';
    case 'EROFS':
      return 'The data volume is read-only. Mount the Jellyport data directory with write access.';
    case 'ENOSPC':
      return 'The data volume has no free space. Free space on the host before restarting Jellyport.';
    case 'EADDRINUSE':
      return 'The configured HTTP port is already in use. Stop the conflicting listener or select another container port.';
    case 'EADDRNOTAVAIL':
      return 'The configured HTTP bind address is unavailable. Set HOST to an address available inside the container.';
    case 'ERR_SOCKET_BAD_PORT':
      return 'The configured HTTP port is invalid. Set PORT to a valid port number.';
    case 'ERR_SQLITE_ERROR':
      return 'The database could not be opened or initialized. Check data volume ownership, write access, free space and database integrity.';
  }
  if (error instanceof Error) {
    const safeMessage = safeErrors.get(error.message);
    if (safeMessage) return safeMessage;
  }
  return 'Check the data volume and configuration.';
}
