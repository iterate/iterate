/// <reference lib="dom" />

import { useEffect, useMemo, useState } from "react";
import { StatusBanner, type StatusTone } from "@iterate-com/jonasland-ui";
import { Button } from "@iterate-com/jonasland-ui/components/button";
import { Input } from "@iterate-com/jonasland-ui/components/input";
import { Label } from "@iterate-com/jonasland-ui/components/label";

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
  const [statusTone, setStatusTone] = useState<StatusTone>("neutral");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial data load should run once on mount
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
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        <section className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-xl font-semibold">Orders Service</h1>
            <Button
              disabled={busy}
              onClick={() => void refresh()}
              type="button"
              variant="secondary"
            >
              Refresh
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">SKU</Label>
              <Input onChange={(event) => setSku(event.target.value)} value={sku} />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Quantity</Label>
              <Input
                min={1}
                onChange={(event) => setQuantity(Number(event.target.value) || 1)}
                type="number"
                value={quantity}
              />
            </div>
          </div>

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              OpenAPI: <code>/api/openapi.json</code>
            </p>
            <p>
              Scalar: <code>/api/docs</code>
            </p>
          </div>

          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void onCreate()} type="button">
              Place order
            </Button>
          </div>

          <StatusBanner tone={statusTone}>{status}</StatusBanner>
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Recent Orders</h2>
          <div className="max-h-[60vh] space-y-2 overflow-auto pr-1">
            {orders.map((order) => {
              const selected = selectedOrderId === order.id;
              return (
                <button
                  className={[
                    "w-full rounded-md border px-3 py-2 text-left text-xs",
                    selected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  ].join(" ")}
                  key={order.id}
                  onClick={() => setSelectedOrderId(order.id)}
                  type="button"
                >
                  <div className="font-mono">{order.id.slice(0, 8)}</div>
                  <div className="text-muted-foreground">
                    {order.sku} x {order.quantity}
                  </div>
                </button>
              );
            })}
            {orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No orders yet.</p>
            ) : null}
          </div>

          {selectedOrder ? (
            <div className="space-y-2 rounded-lg border bg-muted p-3 text-xs">
              <p className="font-mono text-[11px]">{selectedOrder.id}</p>
              <p>Event: {selectedOrder.eventId}</p>
              <p>Created: {formatTime(selectedOrder.createdAt)}</p>
              <p>Updated: {formatTime(selectedOrder.updatedAt)}</p>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Update quantity</Label>
                <Input
                  min={1}
                  onChange={(event) => setUpdateQuantity(Number(event.target.value) || 1)}
                  type="number"
                  value={updateQuantity}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() => void onUpdate()}
                  type="button"
                  variant="secondary"
                >
                  Patch
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void onDelete()}
                  type="button"
                  variant="destructive"
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
