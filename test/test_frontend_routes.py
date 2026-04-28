import re
import unittest
from pathlib import Path


ROUTES_TS = Path(__file__).resolve().parents[1] / "web" / "src" / "lib" / "routes.ts"


def is_image_route(pathname: str | None) -> bool:
    normalized = "/" + re.sub(r"^/+|/+$", "", str(pathname or "").split("?", 1)[0].split("#", 1)[0])
    return normalized == "/image" or normalized.endswith("/image")


class FrontendRouteTests(unittest.TestCase):
    def test_image_route_matches_trailing_slash_and_prefixes(self) -> None:
        self.assertTrue(is_image_route("/image"))
        self.assertTrue(is_image_route("/image/"))
        self.assertTrue(is_image_route("/chatgpt2api/image/"))
        self.assertFalse(is_image_route("/image-manager"))
        self.assertFalse(is_image_route("/login"))

    def test_app_shell_uses_shared_image_route_helper(self) -> None:
        app_shell = (Path(__file__).resolve().parents[1] / "web" / "src" / "components" / "app-shell.tsx").read_text()
        top_nav = (Path(__file__).resolve().parents[1] / "web" / "src" / "components" / "top-nav.tsx").read_text()
        self.assertIn("isImageRoute(pathname)", app_shell)
        self.assertIn("isImageRoute(pathname)", top_nav)

    def test_safari_image_page_uses_cover_viewport_without_body_fixed(self) -> None:
        root_layout = (Path(__file__).resolve().parents[1] / "web" / "src" / "app" / "layout.tsx").read_text()
        app_shell = (Path(__file__).resolve().parents[1] / "web" / "src" / "components" / "app-shell.tsx").read_text()
        self.assertIn("viewportFit: \"cover\"", root_layout)
        self.assertNotIn('document.body.style.position = "fixed"', app_shell)


if __name__ == "__main__":
    unittest.main()
