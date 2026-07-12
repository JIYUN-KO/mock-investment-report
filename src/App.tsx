import { useEffect, useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { ArrowLeft, ArrowRight, BarChart3, Download, Plus, Printer, Search, Settings, Trash2, Trophy, UserRound } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  buildReports,
  Company,
  defaultRoundCount,
  defaultCompanies,
  defaultGroups,
  defaultInvestments,
  initialCapital,
  Investment,
  InvestorReport,
  maxGroupCount,
  makeRounds,
  summarize
} from "./investment";
import { isSupabaseEnabled, loadRemoteWorkbook, saveRemoteWorkbook, subscribeRemoteWorkbook } from "./supabaseWorkbook";

const money = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const kakaoKey = import.meta.env.VITE_KAKAO_JAVASCRIPT_KEY;
const storageKey = "mock-investment-workbook-v1";
const syncChannelName = "mock-investment-workbook-sync";
const authStorageKey = "mock-investment-auth-v1";
const adminPassword = "admin1234";
type ViewMode = "admin" | "investor";
type AuthSession = { role: ViewMode; investor?: string };

type KakaoSdk = {
  isInitialized: () => boolean;
  init: (key: string) => void;
  Share: { sendDefault: (options: Record<string, unknown>) => void };
};

declare global {
  interface Window {
    Kakao?: KakaoSdk;
  }
}

export function App() {
  const saved = loadSavedWorkbook();
  const savedSession = loadAuthSession();
  const [companies, setCompanies] = useState<Company[]>(saved?.companies ?? defaultCompanies);
  const [investments, setInvestments] = useState<Investment[]>(saved?.investments ?? defaultInvestments);
  const [groupCount, setGroupCount] = useState(saved?.groupCount ?? defaultGroups.length);
  const [roundCount, setRoundCount] = useState(saved?.roundCount ?? defaultRoundCount);
  const [currentRound, setCurrentRound] = useState(saved?.currentRound ?? 1);
  const [ledgerRound, setLedgerRound] = useState(saved?.currentRound ?? 1);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("1모둠");
  const [viewMode, setViewMode] = useState<ViewMode>("admin");
  const [session, setSession] = useState<AuthSession | null>(savedSession);
  const [shareStatus, setShareStatus] = useState("투자 장부와 변동률을 수정하면 결과가 즉시 반영됩니다.");
  const lastWorkbookRawRef = useRef("");
  const lastWorkbookUpdatedAtRef = useRef(saved?.updatedAt ?? 0);
  const applyingRemoteWorkbookRef = useRef(false);
  const syncChannelRef = useRef<BroadcastChannel | null>(null);
  const remoteSaveTimerRef = useRef<number | null>(null);

  const rounds = useMemo(() => makeRounds(roundCount), [roundCount]);
  const reports = useMemo(
    () => buildReports(investments, companies, roundCount, currentRound, groupCount),
    [investments, companies, roundCount, currentRound, groupCount]
  );
  const summary = useMemo(() => summarize(reports), [reports]);
  const groupOrderedReports = useMemo(() => [...reports].sort(compareInvestorName), [reports]);
  const filteredReports = reports.filter((report) => report.investor.toLowerCase().includes(query.trim().toLowerCase()));
  const activeReport = reports.find((report) => report.investor === selected) ?? filteredReports[0] ?? reports[0];
  const activeRank = activeReport ? reports.findIndex((report) => report.investor === activeReport.investor) + 1 : 0;
  const chartRows = reports.slice(0, 8).map((report, index) => ({
    name: report.investor,
    순위: index + 1,
    수익률: Number(report.returnRate.toFixed(2)),
    평가손익: Math.round(report.profit / 10000)
  }));

  useEffect(() => {
    if (reports.length > 0 && !reports.some((report) => report.investor === selected)) {
      setSelected(reports[0].investor);
    }
  }, [reports, selected]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const investorFromUrl = params.get("investor");
    if (investorFromUrl) setSelected(investorFromUrl);
    if (params.get("view") === "investor") setViewMode("investor");
    if (savedSession?.role === "investor") {
      setViewMode("investor");
      if (savedSession.investor) setSelected(savedSession.investor);
    }
  }, []);

  function applyWorkbookRaw(raw: string, message: string) {
    if (!raw || raw === lastWorkbookRawRef.current) return;
    const next = parseSavedWorkbook(raw);
    if (!next) return;
    if (next.updatedAt < lastWorkbookUpdatedAtRef.current) return;
    applyingRemoteWorkbookRef.current = true;
    lastWorkbookRawRef.current = raw;
    lastWorkbookUpdatedAtRef.current = next.updatedAt || Date.now();
    setCompanies(next.companies);
    setInvestments(next.investments);
    setGroupCount(next.groupCount);
    setRoundCount(next.roundCount);
    setCurrentRound(next.currentRound);
    setLedgerRound((current) => Math.min(Math.max(1, current), next.roundCount));
    setShareStatus(message);
  }

  useEffect(() => {
    const updatedAt = Date.now();
    const raw = serializeWorkbook({ companies, investments, groupCount, roundCount, currentRound }, updatedAt);
    if (raw === lastWorkbookRawRef.current) return;
    lastWorkbookRawRef.current = raw;
    lastWorkbookUpdatedAtRef.current = updatedAt;
    localStorage.setItem(storageKey, raw);
    if (!applyingRemoteWorkbookRef.current) {
      syncChannelRef.current?.postMessage({ raw, type: "workbook" });
      if (isSupabaseEnabled) {
        if (remoteSaveTimerRef.current) window.clearTimeout(remoteSaveTimerRef.current);
        remoteSaveTimerRef.current = window.setTimeout(() => {
          void saveRemoteWorkbook(raw).catch((error) => {
            console.error("Supabase save failed", error);
            setShareStatus("Supabase 저장 중 문제가 발생했습니다. 네트워크와 환경변수를 확인해주세요.");
          });
        }, 250);
      }
    }
    applyingRemoteWorkbookRef.current = false;
  }, [companies, investments, groupCount, roundCount, currentRound]);

  useEffect(() => {
    function refreshFromStorage(message = "다른 화면에서 수정한 투자 장부를 반영했습니다.") {
      const raw = localStorage.getItem(storageKey);
      if (raw) applyWorkbookRaw(raw, message);
    }

    function syncWorkbook(event: StorageEvent) {
      if (event.key !== storageKey || !event.newValue) return;
      applyWorkbookRaw(event.newValue, "다른 화면에서 수정한 투자 장부를 반영했습니다.");
    }

    const channel = "BroadcastChannel" in window ? new BroadcastChannel(syncChannelName) : null;
    syncChannelRef.current = channel;
    if (channel) {
      channel.onmessage = (event) => {
        if (event.data?.type === "workbook" && typeof event.data.raw === "string") {
          applyWorkbookRaw(event.data.raw, "관리자 화면의 변경사항을 실시간으로 반영했습니다.");
        }
      };
    }

    const interval = window.setInterval(() => refreshFromStorage("저장된 최신 투자 장부를 반영했습니다."), 800);
    const onFocus = () => refreshFromStorage();
    const onVisibilityChange = () => {
      if (!document.hidden) refreshFromStorage();
    };

    if (isSupabaseEnabled) {
      void loadRemoteWorkbook()
        .then((raw) => {
          if (raw && parseSavedWorkbook(raw)) {
            applyWorkbookRaw(raw, "Supabase 서버 장부를 불러왔습니다.");
          } else {
            void saveRemoteWorkbook(serializeWorkbook({ companies, investments, groupCount, roundCount, currentRound }, Date.now()));
            setShareStatus("Supabase에 공용 장부를 새로 만들었습니다.");
          }
        })
        .catch((error) => {
          console.error("Supabase load failed", error);
          refreshFromStorage("Supabase 연결에 실패해 이 브라우저의 저장 장부를 불러왔습니다.");
        });
    } else {
      refreshFromStorage("저장된 최신 투자 장부를 불러왔습니다.");
    }

    const unsubscribeRemote = subscribeRemoteWorkbook((raw) => {
      if (parseSavedWorkbook(raw)) {
        applyWorkbookRaw(raw, "Supabase 서버의 최신 장부를 실시간으로 반영했습니다.");
      }
    });

    window.addEventListener("storage", syncWorkbook);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("storage", syncWorkbook);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      channel?.close();
      if (syncChannelRef.current === channel) syncChannelRef.current = null;
      unsubscribeRemote();
      if (remoteSaveTimerRef.current) window.clearTimeout(remoteSaveTimerRef.current);
    };
  }, []);

  function updateCompanyRate(companyIndex: number, roundIndex: number, value: string) {
    setCompanies((current) =>
      current.map((company, index) =>
        index === companyIndex
          ? {
              ...company,
              rates: makeRounds(roundCount).map((round) => (round - 1 === roundIndex ? toNumber(value) : company.rates[round - 1] ?? 0))
            }
          : company
      )
    );
  }

  function updateCompanyName(companyIndex: number, name: string) {
    const oldName = companies[companyIndex].name;
    setCompanies((current) => current.map((company, index) => (index === companyIndex ? { ...company, name } : company)));
    setInvestments((current) =>
      current.map((investment) => (investment.company === oldName ? { ...investment, company: name } : investment))
    );
  }

  function updateCompanyPrice(companyIndex: number, value: string) {
    setCompanies((current) =>
      current.map((company, index) => (index === companyIndex ? { ...company, price: toNumber(value) } : company))
    );
  }

  function addCompany() {
    setCompanies((current) => [...current, { name: `새기업${current.length + 1}`, price: 10000, rates: rounds.map(() => 0) }]);
  }

  function removeCompany(companyIndex: number) {
    if (companies.length <= 1) {
      setShareStatus("종목은 최소 1개 이상 필요합니다.");
      return;
    }
    const target = companies[companyIndex];
    setCompanies((current) => current.filter((_, index) => index !== companyIndex));
    setInvestments((current) => current.filter((investment) => investment.company !== target.name));
    setShareStatus(`${target.name} 종목과 해당 종목의 투자 장부를 삭제했습니다.`);
  }

  function addRound() {
    setRoundCount((current) => {
      const next = current + 1;
      setCompanies((companiesNow) => companiesNow.map((company) => ({ ...company, rates: [...company.rates, 0] })));
      setLedgerRound(next);
      setCurrentRound(next);
      return next;
    });
  }

  function removeRound(round: number) {
    if (roundCount <= 1) return;
    setRoundCount((current) => current - 1);
    setCompanies((current) => current.map((company) => ({ ...company, rates: company.rates.filter((_, index) => index !== round - 1) })));
    setInvestments((current) =>
      current
        .filter((investment) => investment.round !== round)
        .map((investment) => (investment.round > round ? { ...investment, round: investment.round - 1 } : investment))
    );
    setCurrentRound((current) => (current > round ? current - 1 : Math.min(current, roundCount - 1)));
    setLedgerRound((current) => (current > round ? current - 1 : Math.min(current, roundCount - 1)));
  }

  function closeCurrentRound() {
    if (currentRound >= roundCount) {
      addRound();
      setShareStatus(`${currentRound}라운드를 마감하고 ${currentRound + 1}라운드를 새로 시작했습니다.`);
      return;
    }
    const nextRound = currentRound + 1;
    setInvestments((current) => current.filter((investment) => investment.round !== nextRound));
    setCurrentRound(nextRound);
    setLedgerRound(nextRound);
    setShareStatus(`${currentRound}라운드를 마감하고 ${nextRound}라운드를 시작했습니다.`);
  }

  function reopenPreviousRound() {
    if (currentRound <= 1) {
      setShareStatus("이미 1라운드입니다. 이전 라운드로 돌아갈 수 없습니다.");
      return;
    }
    const previousRound = currentRound - 1;
    setCurrentRound(previousRound);
    setLedgerRound(previousRound);
    setShareStatus(`${previousRound}라운드로 되돌렸습니다. 해당 라운드 장부를 다시 수정할 수 있습니다.`);
  }

  function setInvestmentShares(group: string, round: number, company: string, shares: number) {
    setInvestments((current) => {
      const companyInfo = companies.find((item) => item.name === company);
      const price = companyInfo?.price ?? 0;
      const startAsset = reports.find((report) => report.investor === group)?.rounds.find((item) => item.round === round)?.startAsset ?? initialCapital;
      const otherInvested = current
        .filter((investment) => investment.group === group && investment.round === round && investment.company !== company)
        .reduce((total, investment) => total + investment.shares * (companies.find((item) => item.name === investment.company)?.price ?? 0), 0);
      const maxShares = price > 0 ? Math.max(0, Math.floor((startAsset - otherInvested) / price)) : 0;
      const safeShares = Math.min(Math.max(0, shares), maxShares);
      if (shares > safeShares) {
        setShareStatus(`${group} ${round}라운드 ${company}는 현재 자산 안에서 최대 ${safeShares.toLocaleString("ko-KR")}주까지 입력됩니다.`);
      }
      return [
        ...current.filter((investment) => !(investment.group === group && investment.round === round && investment.company === company)),
        ...(safeShares > 0 ? [{ group, round, company, shares: safeShares }] : [])
      ];
    });
  }

  function removeRoundInvestments(group: string, round: number) {
    setInvestments((current) => current.filter((investment) => !(investment.group === group && investment.round === round)));
  }

  function addGroup() {
    setGroupCount((current) => {
      if (current >= maxGroupCount) {
        setShareStatus(`모둠은 최대 ${maxGroupCount}팀까지 추가할 수 있습니다.`);
        return current;
      }
      const next = current + 1;
      setSelected(`${next}모둠`);
      setShareStatus(`${next}모둠을 추가했습니다.`);
      return next;
    });
  }

  function removeGroup() {
    setGroupCount((current) => {
      if (current <= 1) {
        setShareStatus("모둠은 최소 1팀 이상 필요합니다.");
        return current;
      }
      const removedGroup = `${current}모둠`;
      setInvestments((records) => records.filter((investment) => investment.group !== removedGroup));
      setSelected((selectedGroup) => (selectedGroup === removedGroup ? "1모둠" : selectedGroup));
      setShareStatus(`${removedGroup}과 해당 투자 장부를 삭제했습니다.`);
      return current - 1;
    });
  }

  function resetFromWorkbook() {
    setCompanies(defaultCompanies);
    setInvestments(defaultInvestments);
    setGroupCount(defaultGroups.length);
    setRoundCount(defaultRoundCount);
    setCurrentRound(1);
    setLedgerRound(1);
    setSelected("1모둠");
    setShareStatus("기본 종목 가격과 빈 투자장부로 초기화했습니다.");
  }

  function changeViewMode(nextMode: ViewMode) {
    if (session?.role === "investor" && nextMode === "admin") return;
    setViewMode(nextMode);
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextMode);
    if (activeReport) url.searchParams.set("investor", activeReport.investor);
    window.history.replaceState(null, "", url);
  }

  function handleLogin(nextSession: AuthSession) {
    setSession(nextSession);
    sessionStorage.setItem(authStorageKey, JSON.stringify(nextSession));
    setViewMode(nextSession.role);
    if (nextSession.investor) setSelected(nextSession.investor);
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextSession.role);
    if (nextSession.investor) url.searchParams.set("investor", nextSession.investor);
    window.history.replaceState(null, "", url);
  }

  function handleLogout() {
    setSession(null);
    sessionStorage.removeItem(authStorageKey);
    setViewMode("investor");
  }

  if (!session) {
    return <LoginScreen reports={groupOrderedReports} selected={selected} onLogin={handleLogin} />;
  }

  const canManage = session.role === "admin";
  const effectiveViewMode = canManage ? viewMode : "investor";
  const visibleReport = session.role === "investor" ? reports.find((report) => report.investor === session.investor) ?? activeReport : activeReport;
  const visibleRank = visibleReport ? reports.findIndex((report) => report.investor === visibleReport.investor) + 1 : 0;

  return (
    <main className="app-shell">
      <section className="top-panel">
        <div>
          <p className="eyebrow">{effectiveViewMode === "admin" ? "Admin Console" : "Investor Report"}</p>
          <h1>{effectiveViewMode === "admin" ? "모의주식 투자현황 관리 프로그램" : "모의주식 투자 성적표"}</h1>
        </div>
        <div className="upload-zone">
          {canManage ? (
            <div className="mode-switch" aria-label="화면 전환">
              <button className={effectiveViewMode === "investor" ? "active" : ""} type="button" onClick={() => changeViewMode("investor")}>
                <UserRound size={17} />
                투자자 화면
              </button>
              <button className={effectiveViewMode === "admin" ? "active" : ""} type="button" onClick={() => changeViewMode("admin")}>
                <Settings size={17} />
                관리자 화면
              </button>
            </div>
          ) : null}
          {effectiveViewMode === "admin" ? (
            <button className="ghost-button" type="button" onClick={resetFromWorkbook}>
              원본값 복원
            </button>
          ) : null}
          <button className="ghost-button" type="button" onClick={() => downloadReportPdf(visibleReport ?? activeReport, setShareStatus)}>
            <Download size={18} />
            PDF 다운받기
          </button>
          <button className="ghost-button" type="button" onClick={printReport}>
            <Printer size={18} />
            출력하기
          </button>
          <button className="ghost-button" type="button" onClick={handleLogout}>
            로그아웃
          </button>
        </div>
      </section>

      {effectiveViewMode === "admin" ? (
        <section className="status-strip">
          <BarChart3 size={18} />
          <span>{shareStatus}</span>
        </section>
      ) : null}

      {effectiveViewMode === "admin" ? (
        <>
          <section className="summary-grid">
            <Metric label="참여 모둠" value={`${summary.investors}팀`} />
            <Metric label="모둠별 초기 원금" value={money.format(initialCapital)} />
            <Metric label="현재 라운드" value={`${currentRound}R / ${roundCount}R`} />
            <Metric label="현재 평가금액" value={money.format(summary.value)} />
            <Metric label="전체 수익률" value={`${percent.format(summary.returnRate)}%`} tone={summary.profit >= 0 ? "good" : "bad"} />
          </section>

          <section className="team-control-panel">
            <div>
              <p className="eyebrow">Team Control</p>
              <h2>참여 모둠 {groupCount}팀</h2>
              <span>모둠은 최대 {maxGroupCount}팀까지 운영할 수 있습니다. 새 모둠의 투자장부는 0주로 시작합니다.</span>
            </div>
            <div className="round-actions">
              <button className="secondary-action" disabled={groupCount <= 1} type="button" onClick={removeGroup}>
                <Trash2 size={18} />
                마지막 모둠 삭제
              </button>
              <button className="primary-action" disabled={groupCount >= maxGroupCount} type="button" onClick={addGroup}>
                <Plus size={18} />
                모둠 추가
              </button>
            </div>
          </section>

          <section className="editor-grid">
            <ScenarioEditor
              companies={companies}
              rounds={rounds}
              onRateChange={updateCompanyRate}
              onNameChange={updateCompanyName}
              onPriceChange={updateCompanyPrice}
              onAddCompany={addCompany}
              onRemoveCompany={removeCompany}
              onAddRound={addRound}
              onRemoveRound={removeRound}
            />
            <InvestmentEditor
              companies={companies}
              reports={reports}
              investments={investments}
              rounds={rounds}
              activeRound={ledgerRound}
              currentRound={currentRound}
              onRoundChange={setLedgerRound}
              onSharesChange={setInvestmentShares}
              onClearRound={removeRoundInvestments}
            />
          </section>

          <section className="round-control-panel">
            <div>
              <p className="eyebrow">Round Control</p>
              <h2>{currentRound}라운드 진행 중</h2>
              <span>투자장부 입력을 확인한 뒤 현재 라운드를 마감하고 다음 라운드로 이동합니다.</span>
            </div>
            <div className="round-actions">
              <button className="secondary-action" disabled={currentRound <= 1} type="button" onClick={reopenPreviousRound}>
                <ArrowLeft size={18} />
                이전 라운드
              </button>
              <button className="primary-action" type="button" onClick={closeCurrentRound}>
                다음 라운드
                <ArrowRight size={18} />
              </button>
            </div>
          </section>
        </>
      ) : null}

      {effectiveViewMode === "investor" ? (
        <section className="investor-only-bar">
          {canManage ? (
            <label>
              <span>성적표 선택</span>
              <select value={visibleReport?.investor ?? ""} onChange={(event) => setSelected(event.target.value)}>
                {groupOrderedReports.map((report) => (
                  <option key={report.investor} value={report.investor}>
                    {report.investor}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="locked-investor">
              <UserRound size={18} />
              <span>{visibleReport?.investor ?? session.investor} 로그인</span>
            </div>
          )}
        </section>
      ) : null}

      <section className={effectiveViewMode === "admin" ? "content-grid" : "investor-content"}>
        {effectiveViewMode === "admin" ? (
          <aside className="investor-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">Report</p>
              <h2>모둠별 결과</h2>
            </div>
            <Search size={18} />
          </div>
          <input className="search-input" placeholder="모둠 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="investor-list">
            {filteredReports.map((report, index) => (
              <button
                className={`investor-row ${activeReport?.investor === report.investor ? "active" : ""}`}
                key={report.investor}
                onClick={() => setSelected(report.investor)}
                type="button"
              >
                <span className="rank">{index + 1}</span>
                <span>
                  <strong>{report.investor}</strong>
                  <small>{report.holdings.length}건 투자</small>
                </span>
                <b className={report.profit >= 0 ? "good" : "bad"}>{percent.format(report.returnRate)}%</b>
              </button>
            ))}
          </div>
          </aside>
        ) : null}

        <section className="report-panel">
          {activeReport ? (
            <Report
              report={visibleReport ?? activeReport}
              rank={visibleRank || activeRank}
              total={reports.length}
              rankingRows={chartRows}
              currentRound={currentRound}
            />
          ) : (
            <EmptyState />
          )}
        </section>

        {effectiveViewMode === "admin" ? (
          <section className="chart-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">Ranking</p>
              <h2>수익률 순위</h2>
            </div>
            <Trophy size={18} />
          </div>
          <div className="chart-frame">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartRows} margin={{ top: 20, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip formatter={(value, name) => (name === "평가손익" ? [`${value}만원`, name] : [`${value}%`, name])} />
                <Bar dataKey="수익률" fill="#2563eb" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {summary.best ? (
            <div className="best-box">
              <Trophy size={20} />
              <span>현재 1위</span>
              <strong>{summary.best.investor}</strong>
              <b>{percent.format(summary.best.returnRate)}%</b>
            </div>
          ) : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function LoginScreen({
  reports,
  selected,
  onLogin
}: {
  reports: InvestorReport[];
  selected: string;
  onLogin: (session: AuthSession) => void;
}) {
  const [role, setRole] = useState<ViewMode>("investor");
  const [investor, setInvestor] = useState(selected);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function submitLogin() {
    if (role === "admin") {
      if (password !== adminPassword) {
        setError("관리자 비밀번호가 올바르지 않습니다.");
        return;
      }
      onLogin({ role: "admin" });
      return;
    }

    if (password !== investorCode(investor)) {
      setError(`${investor} 입장코드가 올바르지 않습니다.`);
      return;
    }
    onLogin({ role: "investor", investor });
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div>
          <p className="eyebrow">Mock Investment Access</p>
          <h1>모의주식 투자 프로그램 로그인</h1>
        </div>

        <div className="login-role-tabs" aria-label="로그인 유형">
          <button className={role === "investor" ? "active" : ""} type="button" onClick={() => setRole("investor")}>
            <UserRound size={18} />
            투자자
          </button>
          <button className={role === "admin" ? "active" : ""} type="button" onClick={() => setRole("admin")}>
            <Settings size={18} />
            관리자
          </button>
        </div>

        {role === "investor" ? (
          <label className="login-field">
            <span>투자자 선택</span>
            <select value={investor} onChange={(event) => setInvestor(event.target.value)}>
              {reports.map((report) => (
                <option key={report.investor} value={report.investor}>
                  {report.investor}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="login-field">
          <span>{role === "admin" ? "관리자 비밀번호" : "투자자 입장코드"}</span>
          <input
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitLogin();
            }}
            placeholder={role === "admin" ? "관리자 비밀번호 입력" : "입장코드 입력"}
          />
        </label>

        {error ? <p className="login-error">{error}</p> : null}

        <button className="login-submit" type="button" onClick={submitLogin}>
          {role === "admin" ? "관리자 로그인" : "성적표 보기"}
        </button>
      </section>
    </main>
  );
}

function ScenarioEditor({
  companies,
  rounds,
  onRateChange,
  onNameChange,
  onPriceChange,
  onAddCompany,
  onRemoveCompany,
  onAddRound,
  onRemoveRound
}: {
  companies: Company[];
  rounds: number[];
  onRateChange: (companyIndex: number, roundIndex: number, value: string) => void;
  onNameChange: (companyIndex: number, name: string) => void;
  onPriceChange: (companyIndex: number, value: string) => void;
  onAddCompany: () => void;
  onRemoveCompany: (companyIndex: number) => void;
  onAddRound: () => void;
  onRemoveRound: (round: number) => void;
}) {
  return (
    <section className="data-panel wide-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Sheet 1</p>
          <h2>변동률 시나리오</h2>
        </div>
        <div className="panel-actions">
          <button className="ghost-button compact" type="button" onClick={onAddRound}>
            <Plus size={16} />
            라운드
          </button>
          <button className="icon-button" type="button" onClick={onAddCompany} title="기업 추가">
            <Plus size={18} />
          </button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="edit-table">
          <thead>
            <tr>
              <th>기업명</th>
              <th>주당가격</th>
              <th>삭제</th>
              {rounds.map((round) => (
                <th key={round}>
                  <span className="round-head">
                    {round}라운드
                    {rounds.length > 1 ? (
                      <button className="mini-danger" type="button" onClick={() => onRemoveRound(round)} title={`${round}라운드 삭제`}>
                        ×
                      </button>
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {companies.map((company, companyIndex) => (
              <tr key={`${company.name}-${companyIndex}`}>
                <td>
                  <input value={company.name} onChange={(event) => onNameChange(companyIndex, event.target.value)} />
                </td>
                <td>
                  <input
                    className="price-input"
                    type="number"
                    value={company.price}
                    onChange={(event) => onPriceChange(companyIndex, event.target.value)}
                  />
                  <span>원</span>
                </td>
                <td>
                  <button className="icon-button danger" type="button" onClick={() => onRemoveCompany(companyIndex)} title={`${company.name} 삭제`}>
                    <Trash2 size={16} />
                  </button>
                </td>
                {company.rates.map((rate, roundIndex) => (
                  <td key={roundIndex}>
                    <input
                      className={rate >= 0 ? "positive-input" : "negative-input"}
                      type="number"
                      value={rate}
                      onChange={(event) => onRateChange(companyIndex, roundIndex, event.target.value)}
                    />
                    <span>%</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InvestmentEditor({
  companies,
  reports,
  investments,
  rounds,
  activeRound,
  currentRound,
  onRoundChange,
  onSharesChange,
  onClearRound
}: {
  companies: Company[];
  reports: InvestorReport[];
  investments: Investment[];
  rounds: number[];
  activeRound: number;
  currentRound: number;
  onRoundChange: (round: number) => void;
  onSharesChange: (group: string, round: number, company: string, shares: number) => void;
  onClearRound: (group: string, round: number) => void;
}) {
  const groupReports = reports.slice().sort(compareInvestorName);
  const isClosedRound = activeRound < currentRound;

  function sharesFor(group: string, company: string) {
    return investments.find((investment) => investment.group === group && investment.round === activeRound && investment.company === company)?.shares ?? 0;
  }

  return (
    <section className="data-panel ledger-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Ledger</p>
          <h2>라운드별 투자 장부</h2>
        </div>
      </div>

      <div className="round-tabs" aria-label="투자장부 라운드 선택">
        {rounds.map((round) => (
          <button className={activeRound === round ? "active" : ""} key={round} type="button" onClick={() => onRoundChange(round)}>
            {round}R
            {round === currentRound ? <small>진행중</small> : null}
          </button>
        ))}
      </div>

      <div className="ledger-note">
        <strong>{activeRound}라운드</strong>
        <span>
          {isClosedRound
            ? "마감된 라운드입니다. 입력값은 확인만 가능합니다."
            : "각 칸에 투자할 주수를 입력하세요. 한 라운드 안에서 여러 기업에 분산 투자할 수 있습니다."}
        </span>
      </div>

      <div className="table-scroll">
        <table className="ledger-matrix">
          <thead>
            <tr>
              <th>모둠</th>
              <th>시작 자산</th>
              {companies.map((company) => (
                <th key={company.name}>
                  {company.name}
                  <small>{money.format(company.price)}</small>
                </th>
              ))}
              <th>투자금액</th>
              <th>남은 현금</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groupReports.map((report) => {
              const round = report.rounds.find((item) => item.round === activeRound);
              const startAsset = round?.startAsset ?? initialCapital;
              const invested = round?.invested ?? 0;
              const cash = startAsset - invested;
              return (
                <tr key={report.investor}>
                  <td>
                    <strong>{report.investor}</strong>
                  </td>
                  <td>{money.format(startAsset)}</td>
                  {companies.map((company) => (
                    <td key={company.name}>
                      <input
                        aria-label={`${report.investor} ${activeRound}라운드 ${company.name} 투자 주수`}
                        min={0}
                        disabled={isClosedRound}
                        type="number"
                        value={sharesFor(report.investor, company.name)}
                        onChange={(event) => onSharesChange(report.investor, activeRound, company.name, toNumber(event.target.value))}
                      />
                    </td>
                  ))}
                  <td>{money.format(invested)}</td>
                  <td className={cash >= 0 ? "good" : "bad"}>{money.format(cash)}</td>
                  <td>
                    <button
                      className="icon-button danger"
                      disabled={isClosedRound}
                      type="button"
                      onClick={() => onClearRound(report.investor, activeRound)}
                      title="이 모둠의 라운드 장부 비우기"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function Report({
  report,
  rank,
  total,
  rankingRows,
  currentRound
}: {
  report: InvestorReport;
  rank: number;
  total: number;
  rankingRows: Array<{ name: string; 순위: number; 수익률: number; 평가손익: number }>;
  currentRound: number;
}) {
  const score = investmentScore(report);
  const grade = investmentGrade(score, report.returnRate);
  const comment = investmentComment(report, rank);

  return (
    <article className="print-report report-card" id="investment-report-card">
      <div className="report-card-title">
        <div>
          <p className="eyebrow">Investment Report Card</p>
          <h2>{report.investor} 투자 성적표</h2>
          <span>모의주식 투자 결과 통지서</span>
        </div>
        <div className={`grade-stamp grade-${grade.toLowerCase()}`}>
          <span>등급</span>
          <strong>{grade}</strong>
        </div>
      </div>

      <div className="report-card-grid">
        <div>
          <span>투자 점수</span>
          <strong>{score}점</strong>
        </div>
        <div>
          <span>전체 순위</span>
          <strong>{rank || "-"} / {total || "-"}</strong>
        </div>
        <div>
          <span>수익률</span>
          <strong className={report.profit >= 0 ? "good" : "bad"}>{percent.format(report.returnRate)}%</strong>
        </div>
        <div>
          <span>최종 자산</span>
          <strong>{money.format(report.value)}</strong>
        </div>
      </div>

      <div className="report-metrics">
        <Metric label="초기 원금" value={money.format(report.initialCapital)} />
        <Metric label="평가금액" value={money.format(report.value)} />
        <Metric label="평가손익" value={money.format(report.profit)} tone={report.profit >= 0 ? "good" : "bad"} />
      </div>

      <section className="report-ranking">
        <div>
          <span>순위 그래프</span>
          <strong>{rank || "-"}위 흐름 확인</strong>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={rankingRows} margin={{ top: 12, right: 4, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} />
            <Tooltip formatter={(value, name) => (name === "평가손익" ? [`${value}만원`, name] : [`${value}%`, name])} />
            <Bar dataKey="수익률" fill="#1f4fd8" radius={[5, 5, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section className="teacher-comment">
        <span>투자 종합 의견</span>
        <p>{comment}</p>
      </section>

      <section className="round-flow">
        <div className="section-title-row">
          <div>
            <span>라운드별 자산 흐름</span>
            <strong>{currentRound}라운드 기준 반영 현황</strong>
          </div>
        </div>
        <table className="round-flow-table">
          <thead>
            <tr>
              <th>라운드</th>
              <th>상태</th>
              <th>시작자산</th>
              <th>투자금액</th>
              <th>현금</th>
              <th>손익</th>
              <th>마감자산</th>
            </tr>
          </thead>
          <tbody>
            {report.rounds.map((round) => (
              <tr key={round.round}>
                <td>{round.round}R</td>
                <td>
                  <span className={`round-status ${round.round < currentRound ? "done" : round.round === currentRound ? "active" : "waiting"}`}>
                    {round.round < currentRound ? "마감" : round.round === currentRound ? "진행중" : "예정"}
                  </span>
                </td>
                <td>{money.format(round.startAsset)}</td>
                <td>{money.format(round.invested)}</td>
                <td>{money.format(round.cash)}</td>
                <td className={round.profit >= 0 ? "good" : "bad"}>{money.format(round.profit)}</td>
                <td>{money.format(round.endAsset)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <table className="report-table">
        <colgroup>
          <col className="col-round" />
          <col className="col-company" />
          <col className="col-shares" />
          <col className="col-price" />
          <col className="col-principal" />
          <col className="col-rate" />
          <col className="col-result" />
          <col className="col-profit" />
        </colgroup>
        <thead>
          <tr>
            <th>라운드</th>
            <th>투자기업</th>
            <th>주수</th>
            <th>주당가격</th>
            <th>투자원금</th>
            <th>변동률</th>
            <th>결과금액</th>
            <th>손익</th>
          </tr>
        </thead>
        <tbody>
          {report.holdings.length ? report.holdings.map((holding, index) => (
            <tr key={`${holding.group}-${holding.round}-${holding.company}-${index}`}>
              <td>{holding.round}R</td>
              <td>
                <strong>{holding.company}</strong>
              </td>
              <td>{holding.shares.toLocaleString("ko-KR")}주</td>
              <td>{money.format(holding.price)}</td>
              <td>{money.format(holding.amount)}</td>
              <td className={holding.rate >= 0 ? "good" : "bad"}>{percent.format(holding.rate)}%</td>
              <td>{money.format(holding.value)}</td>
              <td className={holding.profit >= 0 ? "good" : "bad"}>{money.format(holding.profit)}</td>
            </tr>
          )) : (
            <tr>
              <td colSpan={8}>아직 입력된 투자 내역이 없습니다.</td>
            </tr>
          )}
        </tbody>
      </table>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <BarChart3 size={42} />
      <h2>표시할 투자 결과가 없습니다.</h2>
      <p>투자장부에 모둠, 라운드, 기업, 투자 주수를 입력해주세요.</p>
    </div>
  );
}

function reportUrl(report: InvestorReport) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "investor");
  url.searchParams.set("investor", report.investor);
  return url.toString();
}

function reportText(report: InvestorReport) {
  const score = investmentScore(report);
  const grade = investmentGrade(score, report.returnRate);
  const holdings = report.holdings
    .map(
      (holding) =>
        `${holding.round}R ${holding.company} ${holding.shares.toLocaleString("ko-KR")}주 × ${money.format(holding.price)} = ${money.format(holding.amount)} -> ${money.format(holding.value)}(${percent.format(holding.rate)}%)`
    )
    .join(", ");

  return [
    `[모의주식 투자 성적표] ${report.investor}`,
    `등급: ${grade}`,
    `투자점수: ${score}점`,
    `투자원금: ${money.format(report.invested)}`,
    `평가금액: ${money.format(report.value)}`,
    `평가손익: ${money.format(report.profit)}`,
    `수익률: ${percent.format(report.returnRate)}%`,
    `종합의견: ${investmentComment(report, 0)}`,
    `투자내역: ${holdings || "없음"}`
  ].join("\n");
}

async function copyReport(report: InvestorReport, setShareStatus: (message: string) => void) {
  await navigator.clipboard.writeText(`${reportText(report)}\n${reportUrl(report)}`);
  setShareStatus(`${report.investor} 리포트 문구를 복사했습니다.`);
}

async function downloadReportPdf(report: InvestorReport, setShareStatus: (message: string) => void) {
  const element = document.getElementById("investment-report-card");
  if (!element) {
    setShareStatus("PDF로 저장할 성적표를 찾지 못했습니다.");
    return;
  }

  setShareStatus("PDF를 만드는 중입니다.");
  document.body.classList.add("pdf-exporting");

  try {
    const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true
    });
    const image = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 10;
    const imageWidth = pageWidth - margin * 2;
    const imageHeight = (canvas.height * imageWidth) / canvas.width;
    let position = margin;
    let heightLeft = imageHeight;

    pdf.addImage(image, "PNG", margin, position, imageWidth, imageHeight);
    heightLeft -= pageHeight - margin * 2;

    while (heightLeft > 0) {
      position = heightLeft - imageHeight + margin;
      pdf.addPage();
      pdf.addImage(image, "PNG", margin, position, imageWidth, imageHeight);
      heightLeft -= pageHeight - margin * 2;
    }

    pdf.save(`${report.investor}-투자성적표.pdf`);
    setShareStatus(`${report.investor} 투자 성적표 PDF를 저장했습니다.`);
  } catch (error) {
    console.error("PDF export failed", error);
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    setShareStatus(`PDF 저장 중 문제가 발생했습니다: ${message}`);
  } finally {
    document.body.classList.remove("pdf-exporting");
  }
}

function printReport() {
  window.print();
}

async function shareReport(report: InvestorReport, setShareStatus: (message: string) => void) {
  const payload = { title: `${report.investor} 모의주식 투자 리포트`, text: reportText(report), url: reportUrl(report) };
  if (navigator.share) {
    await navigator.share(payload);
    setShareStatus(`${report.investor} 리포트 공유창을 열었습니다.`);
    return;
  }
  await copyReport(report, setShareStatus);
  setShareStatus("이 브라우저는 SNS 공유창을 지원하지 않아 문구를 복사했습니다.");
}

async function shareToKakao(report: InvestorReport, setShareStatus: (message: string) => void) {
  if (!kakaoKey) {
    await copyReport(report, setShareStatus);
    setShareStatus("카카오 JavaScript 키가 없어 문구를 복사했습니다. .env에 VITE_KAKAO_JAVASCRIPT_KEY를 넣으면 카카오톡 공유가 켜집니다.");
    return;
  }

  try {
    const kakao = await loadKakaoSdk();
    if (!kakao.isInitialized()) kakao.init(kakaoKey);
    kakao.Share.sendDefault({
      objectType: "text",
      text: reportText(report),
      link: { mobileWebUrl: reportUrl(report), webUrl: reportUrl(report) }
    });
    setShareStatus(`${report.investor} 리포트를 카카오톡으로 보낼 수 있습니다.`);
  } catch {
    await copyReport(report, setShareStatus);
    setShareStatus("카카오톡 공유를 열지 못해 문구를 복사했습니다.");
  }
}

function loadKakaoSdk(): Promise<KakaoSdk> {
  if (window.Kakao) return Promise.resolve(window.Kakao);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://t1.kakaocdn.net/kakao_js_sdk/2.7.5/kakao.min.js";
    script.async = true;
    script.onload = () => (window.Kakao ? resolve(window.Kakao) : reject());
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function investorCode(investor: string) {
  const number = Number(investor.match(/\d+/)?.[0] ?? 0);
  return String(number).padStart(4, "0");
}

function compareInvestorName(a: InvestorReport, b: InvestorReport) {
  return investorNumber(a.investor) - investorNumber(b.investor) || a.investor.localeCompare(b.investor, "ko");
}

function investorNumber(investor: string) {
  return Number(investor.match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER);
}

function investmentScore(report: InvestorReport) {
  const rawScore = 70 + report.returnRate * 2 + Math.min(report.holdings.length, 5) * 2;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

function investmentGrade(score: number, returnRate: number) {
  if (score >= 95 || returnRate >= 20) return "S";
  if (score >= 85) return "A";
  if (score >= 75) return "B";
  if (score >= 65) return "C";
  return "D";
}

function investmentComment(report: InvestorReport, rank: number) {
  const rankText = rank ? `현재 전체 ${rank}위입니다. ` : "";
  if (report.returnRate >= 15) {
    return `${rankText}높은 수익률을 기록했습니다. 변동률이 큰 기업을 선택하면서도 결과금액을 안정적으로 끌어올린 점이 돋보입니다.`;
  }
  if (report.returnRate >= 0) {
    return `${rankText}투자원금을 지키며 양호한 성과를 냈습니다. 다음 라운드에서는 기업별 변동률 흐름을 비교하면 더 높은 성과를 기대할 수 있습니다.`;
  }
  return `${rankText}평가손익은 손실 구간이지만 투자 결과를 분석하기 좋은 사례입니다. 손실이 발생한 라운드의 기업 선택과 변동률을 다시 확인해보면 다음 전략을 세우는 데 도움이 됩니다.`;
}

function loadSavedWorkbook() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return parseSavedWorkbook(raw);
  } catch {
    return null;
  }
}

function serializeWorkbook(
  workbook: { companies: Company[]; investments: Investment[]; groupCount: number; roundCount: number; currentRound: number },
  updatedAt = Date.now()
) {
  return JSON.stringify({ ...workbook, updatedAt });
}

function parseSavedWorkbook(raw: string) {
  try {
    const parsed = JSON.parse(raw) as {
      companies?: Partial<Company>[];
      investments?: Array<Partial<Investment> & { amount?: number }>;
      groupCount?: number;
      roundCount?: number;
      currentRound?: number;
      updatedAt?: number;
    };
    if (!Array.isArray(parsed.companies) || !Array.isArray(parsed.investments)) return null;
    const savedRoundCount = Math.max(
      1,
      Number(parsed.roundCount ?? Math.max(defaultRoundCount, ...parsed.companies.map((company) => company.rates?.length ?? 0)))
    );
    const companies = parsed.companies.map((company) => {
      const fallback = defaultCompanies.find((item) => item.name === company.name);
      const rates = Array.isArray(company.rates) ? company.rates.map(Number) : fallback?.rates ?? [];
      return {
        name: company.name ?? fallback?.name ?? "새기업",
        price: Number(company.price ?? fallback?.price ?? 10000),
        rates: makeRounds(savedRoundCount).map((round) => rates[round - 1] ?? 0)
      };
    });
    const investments = parsed.investments.map((investment) => {
      const company = companies.find((item) => item.name === investment.company);
      const migratedShares =
        typeof investment.shares === "number"
          ? investment.shares
          : company?.price
            ? Math.round(Number(investment.amount ?? 0) / company.price)
            : 0;
      return {
        group: investment.group ?? "",
        round: Number(investment.round ?? 1),
        company: investment.company ?? "",
        shares: migratedShares
      };
    });
    const inferredGroupCount = Math.max(defaultGroups.length, ...investments.map((investment) => investorNumber(investment.group)).filter(Number.isFinite));
    const groupCount = Math.min(maxGroupCount, Math.max(1, Number(parsed.groupCount ?? inferredGroupCount)));
    const currentRound = Math.min(Math.max(1, Number(parsed.currentRound ?? 1)), savedRoundCount);
    const updatedAt = Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0;
    return {
      companies,
      investments,
      groupCount,
      roundCount: savedRoundCount,
      currentRound,
      updatedAt
    };
  } catch {
    return null;
  }
}

function loadAuthSession() {
  try {
    const raw = sessionStorage.getItem(authStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (parsed.role !== "admin" && parsed.role !== "investor") return null;
    if (parsed.role === "investor" && !parsed.investor) return null;
    return parsed;
  } catch {
    return null;
  }
}
