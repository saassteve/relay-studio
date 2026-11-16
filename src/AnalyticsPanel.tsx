import { useEffect, useState } from "react";
import { api, clock, type Analytics } from "./types";
export function AnalyticsPanel({ id }: { id: string }) {
  const [data, setData] = useState<Analytics | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Analytics>(`/api/videos/${id}/analytics`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);
  if (!data)
    return <p className="muted small">{error || "Loading watch activity…"}</p>;
  const max = Math.max(1, ...data.bins);
  return (
    <div className="analytics-panel">
      <div className="analytics-stats">
        <div>
          <strong>{data.views}</strong>
          <span>Qualified views</span>
        </div>
        <div>
          <strong>{Math.round(data.averageCompletion * 100)}%</strong>
          <span>Average watched</span>
        </div>
        <div>
          <strong>{data.ctaClicks}</strong>
          <span>Next-step clicks</span>
        </div>
      </div>
      <div
        className="engagement-chart"
        role="img"
        aria-label={`Engagement across 20 video sections. ${data.sessions} viewing sessions and ${clock(data.watchSeconds)} watched in total.`}
      >
        {data.bins.map((v, i) => (
          <div
            key={i}
            title={`Section ${i + 1}: ${v} viewers`}
            style={{
              height: "100%",
              background: "transparent",
              display: "flex",
              alignItems: "flex-end",
            }}
          >
            <i style={{ height: `${(v / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="section-heading small muted">
        <span>Start</span>
        <span>
          {data.sessions} sessions · {clock(data.watchSeconds)} watched
        </span>
        <span>End</span>
      </div>
      <p className="studio-hint">
        A view qualifies after 5 seconds or 75% of a short video. Seeking alone
        does not count as watch time.
      </p>
    </div>
  );
}
