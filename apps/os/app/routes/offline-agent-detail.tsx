import { useState, useRef } from "react";
import { Link } from "react-router";
import { ArrowLeft, Upload, Link as LinkIcon, Info } from "lucide-react";
import { unzipSync, strFromU8 } from "fflate";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.tsx";
import { useEstateUrl } from "../hooks/use-estate.ts";
import {
  AgentDetailRenderer,
  type AgentDetailDataGetters,
} from "../components/agent-detail-renderer.tsx";
import { SerializedObjectCodeBlock } from "../components/serialized-object-code-block.tsx";
import type { AgentTraceExport } from "../../backend/agent/agent-export-types.ts";
import type { AugmentedCoreReducedState } from "../../backend/agent/agent-core-schemas.ts";

interface ParsedArchiveData {
  traceData: AgentTraceExport;
  fileBlobs: Map<string, Blob>;
}

function parseArchive(zipData: Uint8Array): ParsedArchiveData {
  const unzipped = unzipSync(zipData);

  const exportJsonData = unzipped["export.json"];
  if (!exportJsonData) {
    throw new Error("Archive does not contain export.json");
  }

  const traceData: AgentTraceExport = JSON.parse(strFromU8(exportJsonData));

  const fileBlobs = new Map<string, Blob>();
  for (const [filename, data] of Object.entries(unzipped)) {
    if (filename.startsWith("files/")) {
      const iterateFileId = filename.substring("files/".length);
      fileBlobs.set(iterateFileId, new Blob([new Uint8Array(data)]));
    }
  }

  return { traceData, fileBlobs };
}

function ArchiveUploader({
  onArchiveLoaded,
}: {
  onArchiveLoaded: (data: ParsedArchiveData) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (file: File) => {
    setIsLoading(true);
    setError(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const parsedData = parseArchive(uint8Array);
      onArchiveLoaded(parsedData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse archive");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUrlLoad = async () => {
    if (!urlInput.trim()) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(urlInput);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const parsedData = parseArchive(uint8Array);
      onArchiveLoaded(parsedData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load archive from URL");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Load Agent Trace</CardTitle>
            <Link to={"/"}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Agents
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="upload" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload">Upload File</TabsTrigger>
              <TabsTrigger value="url">Load from URL</TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="file-upload">Select Archive File</Label>
                <div
                  className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center cursor-pointer hover:border-muted-foreground/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm font-medium">Click to browse files</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Select a .zip archive containing agent trace data
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        handleFileSelect(file);
                      }
                    }}
                    className="hidden"
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="url" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="url-input">Archive URL</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <LinkIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="url-input"
                      type="url"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="https://example.com/trace.zip"
                      className="pl-10"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleUrlLoad();
                        }
                      }}
                    />
                  </div>
                  <Button onClick={handleUrlLoad} disabled={!urlInput.trim() || isLoading}>
                    Load
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {error && (
            <div className="mt-4 p-3 bg-destructive/10 text-destructive rounded-md text-sm">
              {error}
            </div>
          )}

          {isLoading && (
            <div className="mt-4 p-3 bg-muted rounded-md text-sm text-center">
              Loading and parsing archive...
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function OfflineAgentDetailPage() {
  const [archiveData, setArchiveData] = useState<ParsedArchiveData | null>(null);
  const getEstateUrl = useEstateUrl();

  if (!archiveData) {
    return <ArchiveUploader onArchiveLoaded={setArchiveData} />;
  }

  const { traceData, fileBlobs } = archiveData;
  const { metadata, events, reducedStateSnapshots, fileMetadata } = traceData;

  const fileBlobUrls = new Map<string, string>();
  for (const [iterateFileId, blob] of fileBlobs.entries()) {
    fileBlobUrls.set(iterateFileId, URL.createObjectURL(blob));
  }

  const getters: AgentDetailDataGetters = {
    getFileUrl: (iterateFileId: string, disposition: "inline" | "attachment" = "inline") => {
      const url = fileBlobUrls.get(iterateFileId);
      if (!url) {
        console.warn(`File not found in archive: ${iterateFileId}`);
        return "";
      }
      if (disposition === "attachment") {
        const meta = fileMetadata[iterateFileId];
        if (meta?.filename) {
          return url;
        }
      }
      return url;
    },
    getReducedStateAtEventIndex: (eventIndex: number): AugmentedCoreReducedState => {
      return reducedStateSnapshots[eventIndex];
    },
    getBraintrustPermalink: () => {
      return metadata.braintrustPermalink;
    },
  };

  const headerLeft = (
    <div className="flex items-center gap-2">
      <Link to={getEstateUrl("agents/offline")}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            for (const url of fileBlobUrls.values()) {
              URL.revokeObjectURL(url);
            }
            setArchiveData(null);
          }}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Load Different Archive
        </Button>
      </Link>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            <Info className="h-4 w-4 mr-2" />
            View Metadata
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>View Metadata</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 overflow-x-hidden">
            <div>
              <h3 className="font-semibold mb-2">Export Info</h3>
              <div className="text-sm space-y-1 break-all">
                <div>
                  <span className="font-medium">Version:</span> {traceData.version}
                </div>
                <div>
                  <span className="font-medium">Exported At:</span>{" "}
                  {new Date(traceData.exportedAt).toLocaleString()}
                </div>
                <div>
                  <span className="font-medium">Export ID:</span> {metadata.agentTraceExportId}
                </div>
                {metadata.debugUrl && (
                  <div>
                    <span className="font-medium">Debug URL:</span>{" "}
                    <a
                      href={metadata.debugUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline break-all"
                    >
                      {metadata.debugUrl}
                    </a>
                  </div>
                )}
              </div>
            </div>

            {metadata.user && (
              <div>
                <h3 className="font-semibold mb-2">User</h3>
                <div className="max-w-full overflow-hidden">
                  <SerializedObjectCodeBlock data={metadata.user} />
                </div>
              </div>
            )}

            <div>
              <h3 className="font-semibold mb-2">Estate</h3>
              <div className="max-w-full overflow-hidden">
                <SerializedObjectCodeBlock data={metadata.estate} />
              </div>
            </div>

            <div>
              <h3 className="font-semibold mb-2">Organization</h3>
              <div className="max-w-full overflow-hidden">
                <SerializedObjectCodeBlock data={metadata.organization} />
              </div>
            </div>

            <div>
              <h3 className="font-semibold mb-2">Agent Instance</h3>
              <div className="max-w-full overflow-hidden">
                <SerializedObjectCodeBlock data={metadata.agentInstance} />
              </div>
            </div>

            {metadata.iterateConfig && (
              <div>
                <h3 className="font-semibold mb-2">Iterate Config</h3>
                <div className="max-w-full overflow-hidden">
                  <SerializedObjectCodeBlock data={metadata.iterateConfig} />
                </div>
              </div>
            )}

            <div>
              <h3 className="font-semibold mb-2">Statistics</h3>
              <div className="text-sm space-y-1">
                <div>
                  <span className="font-medium">Total Events:</span> {events.length}
                </div>
                <div>
                  <span className="font-medium">Snapshots:</span>{" "}
                  {Object.keys(reducedStateSnapshots).length}
                </div>
                <div>
                  <span className="font-medium">Files:</span> {Object.keys(fileMetadata).length}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );

  const lastReducedState =
    reducedStateSnapshots[events.length - 1] ||
    reducedStateSnapshots[Math.max(...Object.keys(reducedStateSnapshots).map(Number))];

  return (
    <AgentDetailRenderer
      events={events}
      estateId={metadata.estate.id}
      agentClassName={metadata.agentInstance.className}
      reducedState={lastReducedState}
      isWebsocketConnected={false}
      getters={getters}
      headerLeft={headerLeft}
    />
  );
}
