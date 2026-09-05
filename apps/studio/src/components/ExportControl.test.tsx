import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExportJobResponse } from "../api.js";
import { ExportControl } from "./ExportControl.js";

const runningJob: ExportJobResponse = {
  jobId: "job_export_001",
  status: "running",
  progress: 0.42,
  sourceRevision: 7,
  cancelRequested: false,
  canCancel: true,
};

describe("ExportControl", () => {
  it("offers cancellation while a local export is running", () => {
    const html = renderToStaticMarkup(
      <ExportControl
        roughCutReady
        busy={false}
        currentRevision={7}
        job={runningJob}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain("导出中 42%");
    expect(html).toContain("取消");
    expect(html).not.toContain("disabled");
  });

  it("prevents duplicate cancellation while the runner is stopping", () => {
    const html = renderToStaticMarkup(
      <ExportControl
        roughCutReady
        busy={false}
        currentRevision={7}
        job={{ ...runningJob, cancelRequested: true }}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain("正在取消导出…");
    expect(html).toContain("disabled");
  });

  it("keeps a succeeded artifact available and offers a fresh export", () => {
    const html = renderToStaticMarkup(
      <ExportControl
        roughCutReady
        busy={false}
        currentRevision={8}
        job={{
          ...runningJob,
          status: "succeeded",
          progress: 1,
          mediaUrl: "/media/export.mp4",
          captionUrl: "/artifacts/export.srt",
        }}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain("打开成片");
    expect(html).toContain("下载 SRT");
    expect(html).toContain("重新导出");
    expect(html).not.toContain("成片已过期");
  });

  it("marks an older succeeded artifact stale and offers export of the current revision", () => {
    const html = renderToStaticMarkup(
      <ExportControl
        roughCutReady
        busy={false}
        currentRevision={9}
        job={{
          ...runningJob,
          status: "succeeded",
          progress: 1,
          mediaUrl: "/media/export.mp4",
        }}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain("成片已过期");
    expect(html).toContain("重新导出当前版本");
    expect(html).toContain("按当前 REV 9 重新导出原画幅");
  });
});
