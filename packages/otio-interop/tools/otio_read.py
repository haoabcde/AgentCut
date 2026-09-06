#!/usr/bin/env python3
"""OTIO timeline -> normalized JSON structure, via the official OpenTimelineIO library.

Reads an .otio file with the official parser and prints the structural subset
AgentCut's round-trip verification compares against the export plan. Only
reads; never mutates.

Usage: otio_read.py <in.otio>  (normalized JSON on stdout)
"""
import json
import sys

try:
    import opentimelineio as otio
except ModuleNotFoundError:
    sys.stderr.write(
        "opentimelineio is not installed. Run: python3 -m pip install --user opentimelineio\n"
    )
    sys.exit(3)


def to_plain(value):
    """C++ AnyDictionary/AnyVector -> plain JSON-serializable Python values."""
    if hasattr(value, "items"):
        return {str(key): to_plain(entry) for key, entry in value.items()}
    if isinstance(value, (str, bytes)) or value is None or isinstance(value, (int, float, bool)):
        return value
    if hasattr(value, "__iter__"):
        return [to_plain(entry) for entry in value]
    return value


def rational(time):
    return {"value": time.value, "rate": time.rate}


def time_range(value):
    return {"start": rational(value.start_time), "duration": rational(value.duration)}


def normalize_clip(clip):
    reference = clip.media_reference
    media = {"targetUrl": getattr(reference, "target_url", None)}
    available = getattr(reference, "available_range", None)
    if available is not None:
        media["availableRange"] = time_range(available)
    return {
        "type": "clip",
        "name": clip.name,
        "sourceRange": time_range(clip.source_range),
        "mediaReference": media,
        "metadata": to_plain(clip.metadata.get("agentcut", {})),
    }


def main():
    timeline = otio.adapters.read_from_file(sys.argv[1])
    tracks = []
    for track in timeline.tracks:
        items = []
        for child in track:
            if isinstance(child, otio.schema.Gap):
                items.append({"type": "gap", "duration": rational(child.duration())})
            elif isinstance(child, otio.schema.Clip):
                items.append(normalize_clip(child))
        tracks.append({
            "name": track.name,
            "kind": track.kind,
            "metadata": to_plain(track.metadata.get("agentcut", {})),
            "items": items,
        })
    normalized = {
        "name": timeline.name,
        "metadata": to_plain(timeline.metadata.get("agentcut", {})),
        "tracks": tracks,
        # Timeline-level markers live on the Stack (Timeline itself has none).
        "markers": [
            {"name": marker.name, "markedRange": time_range(marker.marked_range)}
            for marker in timeline.tracks.markers
        ],
    }
    json.dump(normalized, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
