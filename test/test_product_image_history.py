import tempfile
import unittest
from pathlib import Path
from unittest import mock

import services.product_service as product_service_module


class ProductImageHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        data_dir_patcher = mock.patch.object(product_service_module, "DATA_DIR", Path(self.temp_dir.name))
        data_dir_patcher.start()
        self.addCleanup(data_dir_patcher.stop)
        self.service = product_service_module.ProductService()

    def _register_user(self, username: str) -> str:
        session = self.service.register(username, "password123")
        return str(session["subject_id"])

    def test_lists_only_successful_images_for_user(self) -> None:
        user_id = self._register_user("alice")
        other_user_id = self._register_user("bob")
        self.service.adjust_user_credits(user_id, 20)
        self.service.adjust_user_credits(other_user_id, 20)
        first = self.service.start_image_job(user_id, "first prompt", "gpt-image-2")
        second = self.service.start_image_job(user_id, "second prompt", "gpt-image-2", kind="edit")
        failed = self.service.start_image_job(user_id, "failed prompt", "gpt-image-2")
        other = self.service.start_image_job(other_user_id, "other prompt", "gpt-image-2")

        self.service.complete_image_job(str(first["id"]), {"data": [{"url": "https://example.test/first.png"}]})
        self.service.complete_image_job(str(second["id"]), {"data": [{"url": "https://example.test/second.png"}]})
        self.service.refund_image_job(str(failed["id"]), "failed")
        self.service.complete_image_job(str(other["id"]), {"data": [{"url": "https://example.test/other.png"}]})

        history = self.service.list_user_image_history(user_id)

        self.assertEqual([item["id"] for item in history], [second["id"], first["id"]])
        self.assertEqual(history[0]["kind"], "edit")
        self.assertEqual(history[0]["prompt"], "second prompt")
        self.assertIsNone(history[0]["result"])

        full_job = self.service.get_image_job(user_id, str(second["id"]))
        self.assertEqual(full_job["result"]["data"][0]["url"], "https://example.test/second.png")
        self.assertEqual(full_job["result_urls"], ["https://example.test/second.png"])

    def test_start_image_job_with_existing_client_request_id_is_idempotent(self) -> None:
        user_id = self._register_user("carol")
        self.service.adjust_user_credits(user_id, 20)

        first = self.service.start_image_job(
            user_id,
            "prompt",
            "gpt-image-2",
            client_request_id="stable-request-id",
        )
        second = self.service.start_image_job(
            user_id,
            "prompt",
            "gpt-image-2",
            client_request_id="stable-request-id",
        )

        self.assertEqual(second["id"], first["id"])
        self.assertTrue(second["existing"])
        self.assertEqual(self.service.get_user(user_id)["credit_balance"], 18)


if __name__ == "__main__":
    unittest.main()
