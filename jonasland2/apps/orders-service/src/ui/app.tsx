/// <reference lib="dom" />

import { useEffect, useMemo, useState } from "react";

interface OrderRecord {
  readonly id: string;
  readonly sku: string;
  readonly quantity: number;
  readonly status: "accepted";
  readonly eventId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ListOrdersResponse {
  readonly orders: OrderRecord[];
  readonly total: number;
}

const formatTime = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

export function App() {
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [sku, setSku] = useState("sku-demo");
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState("Ready");
  const [statusTone, setStatusTone] = useState<"neutral" | "error">("neutral");
  const [busy, setBusy] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [updateQuantity, setUpdateQuantity] = useState<number>(1);

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === selectedOrderId),
    [orders, selectedOrderId],
  );

  const setError = (message: string) => {
    setStatus(message);
    setStatusTone("error");
  };

  const setInfo = (message: string) => {
    setStatus(message);
    setStatusTone("neutral");
  };

  const loadOrders = async () => {
    const response = await fetch("/api/orders?limit=25&offset=0");
    if (!response.ok) {
      throw new Error(`Failed to list orders (${response.status})`);
    }
    const data = (await response.json()) as ListOrdersResponse;
    setOrders(data.orders);
    if (data.orders.length > 0 && !selectedOrderId) {
      setSelectedOrderId(data.orders[0].id);
      setUpdateQuantity(data.orders[0].quantity);
    }
    return data.orders.length;
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const count = await loadOrders();
      setInfo(`Loaded ${String(count)} order(s)`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedOrder) return;
    setUpdateQuantity(selectedOrder.quantity);
  }, [selectedOrder]);

  const onCreate = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku, quantity }),
      });
      if (!response.ok) {
        throw new Error(`Failed to place order (${response.status})`);
      }
      const created = (await response.json()) as OrderRecord;
      setSelectedOrderId(created.id);
      setUpdateQuantity(created.quantity);
      await loadOrders();
      setInfo(`Created order ${created.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = async () => {
    if (!selectedOrderId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(selectedOrderId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity: updateQuantity }),
      });
      if (!response.ok) {
        throw new Error(`Failed to update order (${response.status})`);
      }
      await loadOrders();
      setInfo(`Updated order ${selectedOrderId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selectedOrderId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(selectedOrderId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`Failed to delete order (${response.status})`);
      }
      setSelectedOrderId("");
      setUpdateQuantity(1);
      await loadOrders();
      setInfo("Deleted order");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-6xl gap-6 p-4 md:grid-cols-[2fr_1fr]">
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Orders Service</h1>
          <button
            className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
            disabled={busy}
            onClick={() => void refresh()}
            type="button"
          >
            Refresh
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="text-slate-600">SKU</span>
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              onChange={(event) => setSku(event.target.value)}
              value={sku}
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Quantity</span>
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              min={1}
              onChange={(event) => setQuantity(Number(event.target.value) || 1)}
              type="number"
              value={quantity}
            />
          </label>
        </div>

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          OpenAPI: <code>/api/openapi.json</code>
          <br />
          Scalar: <code>/api/docs</code>
        </div>

        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            disabled={busy}
            onClick={() => void onCreate()}
            type="button"
          >
            Place order
          </button>
        </div>

        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            statusTone === "error"
              ? "border-rose-300 bg-rose-50 text-rose-800"
              : "border-slate-200 bg-slate-50 text-slate-700"
          }`}
        >
          {status}
        </div>
      </section>

      <aside className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recent Orders
        </h2>
        <div className="max-h-[60vh] space-y-2 overflow-auto">
          {orders.map((order) => (
            <button
              className={`w-full rounded-md border px-3 py-2 text-left text-xs ${
                selectedOrderId === order.id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
              key={order.id}
              onClick={() => setSelectedOrderId(order.id)}
              type="button"
            >
              <div className="font-mono">{order.id.slice(0, 8)}</div>
              <div className={selectedOrderId === order.id ? "text-slate-200" : "text-slate-600"}>
                {order.sku} x {order.quantity}
              </div>
            </button>
          ))}
          {orders.length === 0 ? <p className="text-sm text-slate-500">No orders yet.</p> : null}
        </div>

        {selectedOrder ? (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-mono text-[11px]">{selectedOrder.id}</p>
            <p>Event: {selectedOrder.eventId}</p>
            <p>Created: {formatTime(selectedOrder.createdAt)}</p>
            <p>Updated: {formatTime(selectedOrder.updatedAt)}</p>
            <label className="block">
              <span className="text-slate-600">Update quantity</span>
              <input
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
                min={1}
                onChange={(event) => setUpdateQuantity(Number(event.target.value) || 1)}
                type="number"
                value={updateQuantity}
              />
            </label>
            <div className="flex gap-2">
              <button
                className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100"
                disabled={busy}
                onClick={() => void onUpdate()}
                type="button"
              >
                Patch
              </button>
              <button
                className="rounded-md border border-rose-300 px-2 py-1 text-rose-700 hover:bg-rose-50"
                disabled={busy}
                onClick={() => void onDelete()}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}
      </aside>
    </main>
  );
}
