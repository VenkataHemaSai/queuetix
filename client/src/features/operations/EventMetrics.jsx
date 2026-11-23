import { useQuery } from "@tanstack/react-query";
import { useSession } from "../auth/session.jsx";
import "./operations.css";

const metrics = [
  ["queueLength", "People in queue"],
  ["activeAdmissions", "Active admissions"],
  ["activeHolds", "Active holds"],
  ["availableSeats", "Available seats"],
  ["soldSeats", "Sold seats"],
  ["reclaimableSeats", "Seats eligible for reclaim"],
];

export function useEventMetrics(id) {
  const { request, user } = useSession();
  return useQuery({
    queryKey: ["operations", user.id, "metrics", id],
    queryFn: ({ signal }) => request("/operations/events/" + id, { signal }),
    refetchInterval: 15_000,
  });
}

export function EventMetricValues({ values }) {
  return (
    <dl className="ops-metrics">
      {metrics.map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{values[key] ?? "Unavailable"}</dd>
        </div>
      ))}
    </dl>
  );
}
