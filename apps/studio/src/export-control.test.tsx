import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExportJobResponse } from "./api.js";
import { ExportControl } from "./components/ExportControl.js";

describe("ExportControl", () => {
  it("explains why export is unavailable during review", () => {
    const html = renderToStaticMarkup(
      <ExportControl roughCutReady={false} busy={false} currentRevision={8} onExport={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain("还有候选未决定");
    expect(html).toContain("disabled");
  });

  it("shows persisted render progress", () => {
    const job: ExportJobResponse = {
      jobId: "job_1",
      status: "running",
      progress: 0.42,
      sourceRevision: 8,
      cancelRequested: false,
      canCancel: true,
    };
    const html = renderToStaticMarkup(
      <ExportControl roughCutReady busy={false} currentRevision={8} job={job} onExport={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain("导出中 42%");
  });

  it("links the verified final media", () => {
    const job: ExportJobResponse = {
      jobId: "job_1",
      status: "succeeded",
      progress: 1,
      sourceRevision: 8,
      cancelRequested: false,
      canCancel: false,
      mediaUrl: "/media/output",
      captionUrl: "/artifacts/captions",
    };
    const html = renderToStaticMarkup(
      <ExportControl roughCutReady busy={false} currentRevision={9} job={job} onExport={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain("打开成片");
    expect(html).toContain("/media/output");
    expect(html).toContain("下载 SRT");
  });

  it("offers an explicit vertical preset with its approximation disclosed", () => {
    const html = renderToStaticMarkup(
      <ExportControl roughCutReady busy={false} currentRevision={8} onExport={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain("导出成片");
    expect(html).toContain("导出 9:16 竖屏");
    expect(html).toContain("近似取景");
  });

  it("labels a running vertical export and warns on the approximate result", () => {
    const running: ExportJobResponse = {
      jobId: "job_vertical",
      status: "running",
      progress: 0.5,
      sourceRevision: 8,
      preset: "vertical-9-16",
      cancelRequested: false,
      canCancel: true,
    };
    const runningHtml = renderToStaticMarkup(
      <ExportControl roughCutReady busy={false} currentRevision={8} job={running} onExport={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(runningHtml).toContain("9:16 竖屏");

    const succeeded: ExportJobResponse = {
      jobId: "job_vertical",
      status: "succeeded",
      progress: 1,
      sourceRevision: 8,
      preset: "vertical-9-16",
      cancelRequested: false,
      canCancel: false,
      mediaUrl: "/media/vertical",
      quality: {
        passed: true,
        durationDeltaMillis: 10,
        width: 1080,
        height: 1920,
        hasAudio: true,
        subtitleCueCount: 18,
        fitMode: "cover",
        fitModeApproximate: true,
      },
    };
    const succeededHtml = renderToStaticMarkup(
      <ExportControl roughCutReady busy={false} currentRevision={9} job={succeeded} onExport={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(succeededHtml).toContain("9:16 竖屏");
    expect(succeededHtml).toContain("中心裁切近似取景");
  });
});
