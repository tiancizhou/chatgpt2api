export function isImageRoute(pathname: string | null | undefined) {
  const normalizedPathname = `/${String(pathname || "").split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "")}`;
  return normalizedPathname === "/image" || normalizedPathname.endsWith("/image");
}
