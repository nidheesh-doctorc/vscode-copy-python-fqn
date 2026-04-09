import importlib.util
from pathlib import Path
import unittest
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = REPO_ROOT / "host-scripts" / "server.py"
SPEC = importlib.util.spec_from_file_location("host_task_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load host task server module from {SERVER_PATH}")
host_task_server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host_task_server)


class DirectCommandValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = str(REPO_ROOT)
        self.manage_emulators_command = (
            f"{self.workspace}/infra/scripts/manage-emulators.sh run drc_test_1"
        )
        self.docker_compose_command = " ".join(host_task_server.DIRECT_DOCKER_COMPOSE_ARGV)

    def test_manage_emulators_command_is_allowed(self) -> None:
        argv, rule = host_task_server.validate_direct_command(
            self.manage_emulators_command,
            self.workspace,
        )

        self.assertEqual(
            argv,
            [
                f"{self.workspace}/infra/scripts/manage-emulators.sh",
                "run",
                "drc_test_1",
            ],
        )
        self.assertEqual(rule, "manage-emulators script")

    def test_manage_emulators_rejects_different_executable(self) -> None:
        command = "/tmp/manage-emulators.sh run drc_test_1"

        with self.assertRaisesRegex(ValueError, "Direct command is not allowed"):
            host_task_server.validate_direct_command(command, self.workspace)

    def test_docker_compose_command_is_allowed_exactly(self) -> None:
        with mock.patch.object(host_task_server.shutil, "which", return_value="/usr/local/bin/docker-compose"):
            argv, rule = host_task_server.validate_direct_command(
                self.docker_compose_command,
                self.workspace,
            )

        self.assertEqual(argv[0], "/usr/local/bin/docker-compose")
        self.assertEqual(argv[1:], host_task_server.DIRECT_DOCKER_COMPOSE_ARGV[1:])
        self.assertEqual(rule, "docker-compose")

    def test_docker_compose_rejects_extra_flags(self) -> None:
        command = f"{self.docker_compose_command} --remove-orphans"

        with mock.patch.object(host_task_server.shutil, "which", return_value="/usr/local/bin/docker-compose"):
            with self.assertRaisesRegex(ValueError, "Direct command is not allowed"):
                host_task_server.validate_direct_command(command, self.workspace)

    def test_direct_execution_context_rejects_env_overrides(self) -> None:
        with self.assertRaisesRegex(ValueError, "env overrides"):
            host_task_server.validate_direct_execution_context(
                {"EVIL": "1"},
                None,
                self.workspace,
            )

    def test_direct_execution_context_rejects_non_workspace_cwd(self) -> None:
        with self.assertRaisesRegex(ValueError, "cwd overrides"):
            host_task_server.validate_direct_execution_context(
                None,
                "/tmp",
                self.workspace,
            )

    def test_prepare_direct_execution_uses_server_derived_env_and_workspace_cwd(self) -> None:
        with mock.patch.dict(host_task_server.os.environ, {"BASE_ENV": "1"}, clear=True):
            with mock.patch.object(
                host_task_server,
                "load_interactive_shell_environment",
                return_value={"LOGIN_ENV": "2"},
            ):
                with mock.patch.object(host_task_server, "log_server"):
                    argv, cwd, env = host_task_server.prepare_direct_execution(
                        ["/bin/echo", "ok"],
                        self.workspace,
                    )

        self.assertEqual(argv, ["/bin/echo", "ok"])
        self.assertEqual(cwd, self.workspace)
        self.assertEqual(env["BASE_ENV"], "1")
        self.assertEqual(env["LOGIN_ENV"], "2")
        self.assertEqual(env["COREPACK_ENABLE_DOWNLOAD_PROMPT"], "0")
        self.assertNotIn("EVIL", env)


if __name__ == "__main__":
    unittest.main()