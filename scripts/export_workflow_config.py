"""Read the canonical YAML rules and messages for the Node service."""
import json
from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[1]
job = yaml.safe_load((root / 'config/jobs/game-execution-planner.yaml').read_text(encoding='utf-8-sig'))
messages = yaml.safe_load((root / job['job']['messages_file']).read_text(encoding='utf-8-sig'))
print(json.dumps({'rules': job, 'messages': messages['messages']}, ensure_ascii=False))
