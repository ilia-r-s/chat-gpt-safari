"""Check that regenerating the project preserves Xcode signing edits."""
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
cache = root / ".cache"
cache.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=cache) as temp:
    fixture = Path(temp)
    (fixture / "scripts").mkdir()
    generator = shutil.copy(root / "scripts/generate-project.py", fixture / "scripts")
    command = [sys.executable, generator]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    project = fixture / "SafariChat.xcodeproj/project.pbxproj"

    def read_project():
        return json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", project]))

    original = read_project()
    expected = {}
    targets = original["objects"][original["rootObject"]]["attributes"]["TargetAttributes"]
    for ident, attrs in targets.items():
        attrs.update(DevelopmentTeam="TEAMDEBUG1", ProvisioningStyle="Manual")
        target = original["objects"][ident]
        configs = original["objects"][target["buildConfigurationList"]]["buildConfigurations"]
        for config_id in configs:
            config = original["objects"][config_id]
            signing = {
                "DEVELOPMENT_TEAM": "TEAMDEBUG1" if config["name"] == "Debug" else "TEAMREL001",
                "CODE_SIGN_STYLE": "Manual",
                "CODE_SIGN_IDENTITY[sdk=macosx*]": "Apple Development",
                "PROVISIONING_PROFILE_SPECIFIER": f'{target["name"]} {config["name"]}',
                "SAFARI_CHAT_GROUP_ID": "example.shared",
            }
            expected[config_id] = signing
            config["buildSettings"].update(signing, CURRENT_PROJECT_VERSION="0")
    project.write_bytes(plistlib.dumps(original))

    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    result = read_project()
    assert len(expected) == 4
    for config_id, signing in expected.items():
        settings = result["objects"][config_id]["buildSettings"]
        assert {key: settings.get(key) for key in signing} == signing
        assert settings["CURRENT_PROJECT_VERSION"] != "0"
    assert result["objects"][result["rootObject"]]["attributes"]["TargetAttributes"] == targets
    first = project.read_bytes()
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    assert project.read_bytes() == first
print("Project regeneration preserved signing in both targets and configurations.")
