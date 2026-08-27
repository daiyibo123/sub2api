// Header utilities

export function getModelFromHeader(request: Request): string | null {
  const preferredHeaders = [
    'x-requested-model',
    'x-model',
    'model'
  ];

  for (const name of preferredHeaders) {
    const value = request.headers.get(name);
    if (value && value.trim()) {
      return value.trim();
  }
  }

  return null;
}
