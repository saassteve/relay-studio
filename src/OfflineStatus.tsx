import { useEffect, useState } from "react";
export function OfflineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);
  return online ? null : (
    <div className="offline-status" role="status">
      Offline · Recordings stay on this device and sync when you reconnect.
    </div>
  );
}
