import { createClient } from "@supabase/supabase-js";

export const workbookId = "classroom-default";
export const workbookTable = "investment_workbooks";

type WorkbookRow = {
  id: string;
  data: string | Record<string, unknown>;
  updated_at?: string;
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseEnabled = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseEnabled ? createClient(supabaseUrl as string, supabaseAnonKey as string) : null;

export async function loadRemoteWorkbook() {
  if (!supabase) return null;
  const { data, error } = await supabase.from(workbookTable).select("data").eq("id", workbookId).maybeSingle<WorkbookRow>();
  if (error) throw error;
  return normalizeWorkbookData(data?.data);
}

export async function saveRemoteWorkbook(raw: string) {
  if (!supabase) return;
  const { error } = await supabase.from(workbookTable).upsert({
    id: workbookId,
    data: JSON.parse(raw),
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
}

export function subscribeRemoteWorkbook(onChange: (raw: string) => void) {
  if (!supabase) return () => undefined;
  const channel = supabase
    .channel("investment-workbook-sync")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: workbookTable, filter: `id=eq.${workbookId}` },
      (payload) => {
        const next = payload.new as WorkbookRow | null;
        const raw = normalizeWorkbookData(next?.data);
        if (raw) onChange(raw);
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

function normalizeWorkbookData(value: WorkbookRow["data"] | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
