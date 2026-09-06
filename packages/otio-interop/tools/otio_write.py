#!/usr/bin/env python3
"""AgentCut export plan -> OTIO timeline, via the official OpenTimelineIO library.

This script is deliberately dumb: every IR semantic decision (gap insertion,
loss classification, metadata encoding) is made upstream in the TypeScript plan
builder. It only constructs official otio.schema objects and serializes them,
guaranteeing the emitted file is a valid OTIO document per the reference
implementation.

Usage: otio_write.py <plan.json> <out.otio>
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


def rational(time):
    return otio.opentime.RationalTime(time["value"], time["rate"])


def time_range(value):
    return otio.opentime.TimeRange(rational(value["start"]), rational(value["duration"]))


def main():
    plan_path, out_path = sys.argv[1], sys.argv[2]
    with open(plan_path, "r", encoding="utf-8") as handle:
        plan = json.load(handle)

    timeline = otio.schema.Timeline(name=plan["name"])
    timeline.metadata["agentcut"] = plan.get("metadata", {})

    for track_plan in plan["tracks"]:
        track = otio.schema.Track(name=track_plan["name"], kind=track_plan["kind"])
        track.metadata["agentcut"] = track_plan.get("metadata", {})
        for item in track_plan["items"]:
            if item["type"] == "gap":
                track.append(otio.schema.Gap(duration=rational(item["duration"])))
                continue
            clip = otio.schema.Clip(name=item["name"])
            reference = item["mediaReference"]
            available = (
                time_range(reference["availableRange"])
                if reference.get("availableRange")
                else None
            )
            clip.media_reference = otio.schema.ExternalReference(
                target_url=reference["targetUrl"],
                available_range=available,
            )
            clip.source_range = time_range(item["sourceRange"])
            clip.metadata["agentcut"] = item.get("metadata", {})
            track.append(clip)
        timeline.tracks.append(track)

    # Timeline has no markers in OTIO; timeline-level markers live on the Stack.
    for marker in plan.get("markers", []):
        timeline.tracks.markers.append(
            otio.schema.Marker(name=marker["name"], marked_range=time_range(marker["markedRange"]))
        )

    otio.adapters.write_to_file(timeline, out_path)


if __name__ == "__main__":
    main()
