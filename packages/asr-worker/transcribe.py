import argparse
import json
import os
import tempfile

import mlx_whisper
from importlib.metadata import version
from strict_json import sanitize_for_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AgentCut MLX Whisper worker")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--initial-prompt")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = mlx_whisper.transcribe(
        args.input,
        path_or_hf_repo=args.model,
        language=args.language,
        task="transcribe",
        word_timestamps=True,
        verbose=False,
        initial_prompt=args.initial_prompt,
        condition_on_previous_text=True,
    )
    result["agentcut_provider"] = {
        "name": "mlx-whisper",
        "version": version("mlx-whisper"),
        "model": args.model,
    }
    result = sanitize_for_json(result)
    output_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(output_dir, exist_ok=True)
    file_descriptor, temporary_path = tempfile.mkstemp(prefix=".asr-", suffix=".json", dir=output_dir)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as output_file:
            json.dump(
                result,
                output_file,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary_path, args.output)
    except BaseException:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)
        raise


if __name__ == "__main__":
    main()
