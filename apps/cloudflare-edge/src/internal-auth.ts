export function bearerAuthorized(request: Request, secret: string): boolean {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const received = value.slice("Bearer ".length);
  if (received.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index += 1) {
    difference |= received.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return difference === 0;
}
