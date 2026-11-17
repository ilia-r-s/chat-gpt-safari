#!/usr/bin/env python3
"""Prepare a local marketplace and ZIP without installing or publishing anything."""
from pathlib import Path
import json
import shutil

root = Path(__file__).resolve().parents[1]
target = root / 'build/desktop-marketplace'
plugin = target / 'plugins/safari-chat'
shutil.copytree(root / 'plugins/safari-chat', plugin, dirs_exist_ok=True)
catalog = target / '.agents/plugins/marketplace.json'
catalog.parent.mkdir(parents=True, exist_ok=True)
catalog.write_text(json.dumps({
    'name': 'safari-chat-local',
    'interface': {'displayName': 'Safari Chat — Local'},
    'plugins': [{'name': 'safari-chat', 'source': {'source': 'local', 'path': './plugins/safari-chat'},
                 'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Productivity'}]
}, indent=2) + '\n')
shutil.make_archive(str(root / 'build/Safari-Chat-desktop-plugin'), 'zip', plugin)
print('Prepared build/desktop-marketplace and build/Safari-Chat-desktop-plugin.zip')
