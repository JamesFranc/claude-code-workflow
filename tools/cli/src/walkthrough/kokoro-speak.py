import argparse
import json
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24000


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", required=True)
    parser.add_argument("--speed", type=float, required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--words", required=True)
    args = parser.parse_args()

    pipeline = KPipeline(lang_code=args.voice[0], repo_id="hexgrad/Kokoro-82M")
    chunks = []
    words = []
    offset = 0.0
    for result in pipeline(sys.stdin.read(), voice=args.voice, speed=args.speed):
        if result.audio is None:
            continue
        for token in result.tokens or []:
            if token.start_ts is not None and token.end_ts is not None:
                words.append(
                    {
                        "text": token.text,
                        "start": offset + token.start_ts,
                        "end": offset + token.end_ts,
                    }
                )
        audio = result.audio.numpy()
        chunks.append(audio)
        offset += len(audio) / SAMPLE_RATE
    if not chunks:
        sys.exit("kokoro produced no audio")
    sf.write(args.audio, np.concatenate(chunks), SAMPLE_RATE)
    with open(args.words, "w", encoding="utf-8") as out:
        json.dump(words, out)


if __name__ == "__main__":
    main()
