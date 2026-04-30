from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import services.product_service as product_service_module


class ProductCdkDailyLimitTests(unittest.TestCase):
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

    def _create_codes(self, count: int = 2, amount: int = 10) -> list[str]:
        return [item["code"] for item in self.service.create_cdks(count, amount, "admin")]

    def _cdk_status_by_preview(self) -> dict[str, str]:
        return {item["code_preview"]: item["status"] for item in self.service.list_cdks()}

    def test_same_user_can_redeem_only_once_per_day(self) -> None:
        user_id = self._register_user("alice")
        first_code, second_code = self._create_codes(2, 10)

        first_result = self.service.redeem_cdk(user_id, first_code)

        self.assertEqual(first_result["balance"], 10)
        with self.assertRaises(product_service_module.ProductServiceError) as context:
            self.service.redeem_cdk(user_id, second_code)
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(context.exception.message, "每天只能兑换 1 次 CDK")
        self.assertEqual(self.service.get_user(user_id)["credit_balance"], 10)
        statuses = self._cdk_status_by_preview()
        self.assertEqual(statuses[self.service._preview_code(second_code)], "unused")

    def test_different_users_can_each_redeem_once_per_day(self) -> None:
        alice_id = self._register_user("alice")
        bob_id = self._register_user("bob")
        first_code, second_code = self._create_codes(2, 10)

        alice_result = self.service.redeem_cdk(alice_id, first_code)
        bob_result = self.service.redeem_cdk(bob_id, second_code)

        self.assertEqual(alice_result["balance"], 10)
        self.assertEqual(bob_result["balance"], 10)

    def test_invalid_code_does_not_consume_daily_redeem_chance(self) -> None:
        user_id = self._register_user("alice")
        [code] = self._create_codes(1, 10)

        with self.assertRaises(product_service_module.ProductServiceError):
            self.service.redeem_cdk(user_id, "invalid-code")

        result = self.service.redeem_cdk(user_id, code)
        self.assertEqual(result["balance"], 10)

    def test_disabled_code_does_not_consume_daily_redeem_chance(self) -> None:
        user_id = self._register_user("alice")
        disabled_code, valid_code = self._create_codes(2, 10)
        disabled_id = next(item["id"] for item in self.service.list_cdks() if item["code_preview"] == self.service._preview_code(disabled_code))
        self.service.disable_cdk(disabled_id)

        with self.assertRaises(product_service_module.ProductServiceError):
            self.service.redeem_cdk(user_id, disabled_code)

        result = self.service.redeem_cdk(user_id, valid_code)
        self.assertEqual(result["balance"], 10)

    def test_already_redeemed_code_does_not_consume_daily_redeem_chance(self) -> None:
        alice_id = self._register_user("alice")
        bob_id = self._register_user("bob")
        first_code, second_code = self._create_codes(2, 10)
        self.service.redeem_cdk(alice_id, first_code)

        with self.assertRaises(product_service_module.ProductServiceError):
            self.service.redeem_cdk(bob_id, first_code)

        result = self.service.redeem_cdk(bob_id, second_code)
        self.assertEqual(result["balance"], 10)

    def test_daily_limit_uses_shanghai_calendar_day(self) -> None:
        user_id = self._register_user("alice")
        first_code, second_code = self._create_codes(2, 10)

        with mock.patch.object(product_service_module, "_now", return_value=datetime(2026, 4, 28, 16, 30, 0)):
            self.service.redeem_cdk(user_id, first_code)
        with mock.patch.object(product_service_module, "_now", return_value=datetime(2026, 4, 29, 15, 30, 0)):
            with self.assertRaises(product_service_module.ProductServiceError):
                self.service.redeem_cdk(user_id, second_code)

    def test_user_can_redeem_again_after_shanghai_calendar_day_changes(self) -> None:
        user_id = self._register_user("alice")
        first_code, second_code = self._create_codes(2, 10)

        with mock.patch.object(product_service_module, "_now", return_value=datetime(2026, 4, 29, 15, 30, 0)):
            self.service.redeem_cdk(user_id, first_code)
        with mock.patch.object(product_service_module, "_now", return_value=datetime(2026, 4, 29, 16, 30, 0)):
            result = self.service.redeem_cdk(user_id, second_code)

        self.assertEqual(result["balance"], 20)

    def test_concurrent_redeems_only_allow_one_success(self) -> None:
        user_id = self._register_user("alice")
        first_code, second_code = self._create_codes(2, 10)
        services = [product_service_module.ProductService(), product_service_module.ProductService()]
        barrier = Barrier(2)

        def redeem(args: tuple[product_service_module.ProductService, str]) -> bool:
            service, code = args
            barrier.wait()
            try:
                service.redeem_cdk(user_id, code)
                return True
            except product_service_module.ProductServiceError:
                return False

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(redeem, zip(services, [first_code, second_code])))

        self.assertEqual(results.count(True), 1)
        self.assertEqual(self.service.get_user(user_id)["credit_balance"], 10)
        statuses = [item["status"] for item in self.service.list_cdks()]
        self.assertEqual(statuses.count("redeemed"), 1)
        self.assertEqual(statuses.count("unused"), 1)

    def test_failed_concurrent_same_code_redeem_does_not_consume_daily_chance(self) -> None:
        alice_id = self._register_user("alice")
        bob_id = self._register_user("bob")
        shared_code, retry_code = self._create_codes(2, 10)
        services = [product_service_module.ProductService(), product_service_module.ProductService()]
        barrier = Barrier(2)

        def redeem(args: tuple[product_service_module.ProductService, str]) -> tuple[str, bool]:
            service, user_id = args
            barrier.wait()
            try:
                service.redeem_cdk(user_id, shared_code)
                return user_id, True
            except product_service_module.ProductServiceError:
                return user_id, False

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(redeem, zip(services, [alice_id, bob_id])))

        failed_user_id = next(user_id for user_id, success in results if not success)
        retry_result = self.service.redeem_cdk(failed_user_id, retry_code)

        self.assertEqual(retry_result["balance"], 10)


if __name__ == "__main__":
    unittest.main()
