export type Company = {
  name: string;
  price: number;
  rates: number[];
};

export type Investment = {
  group: string;
  round: number;
  company: string;
  shares: number;
};

export type Holding = Investment & {
  price: number;
  amount: number;
  rate: number;
  value: number;
  profit: number;
  returnRate: number;
};

export type RoundSummary = {
  round: number;
  startAsset: number;
  invested: number;
  cash: number;
  value: number;
  profit: number;
  endAsset: number;
  overspent: number;
};

export type InvestorReport = {
  investor: string;
  initialCapital: number;
  invested: number;
  value: number;
  profit: number;
  returnRate: number;
  holdings: Holding[];
  rounds: RoundSummary[];
};

export const initialCapital = 5000000;
export const defaultGroups = ["1모둠", "2모둠", "3모둠", "4모둠", "5모둠", "6모둠"];
export const defaultRoundCount = 7;

export function makeRounds(roundCount: number) {
  return Array.from({ length: Math.max(1, roundCount) }, (_, index) => index + 1);
}

export const defaultCompanies: Company[] = [
  { name: "고대자동차", price: 100000, rates: [-5, 8, 15, -35, 10, -5, 40] },
  { name: "초록여신커피", price: 50000, rates: [25, 5, -15, 12, -8, -40, 50] },
  { name: "삼선운동화", price: 80000, rates: [2, -8, 30, 5, -12, 15, -5] },
  { name: "파인애플", price: 120000, rates: [-12, 45, -5, 50, -20, 8, -15] },
  { name: "구세계", price: 70000, rates: [8, -3, 12, 2, -30, 35, 10] },
  { name: "바이브", price: 60000, rates: [35, -15, 5, 8, 25, -2, -10] },
  { name: "비거퀸", price: 40000, rates: [-20, 10, -10, 40, 5, 45, -50] }
];

export const defaultInvestments: Investment[] = [
  { group: "1모둠", round: 1, company: "고대자동차", shares: 5 },
  { group: "1모둠", round: 1, company: "초록여신커피", shares: 8 },
  { group: "2모둠", round: 1, company: "파인애플", shares: 2 }
];

export function buildReports(investments: Investment[], companies: Company[], roundCount: number, currentRound = roundCount): InvestorReport[] {
  const groups = Array.from(new Set([...defaultGroups, ...investments.map((investment) => investment.group).filter(Boolean)]));
  const rounds = makeRounds(roundCount);
  const activeRoundLimit = Math.min(Math.max(1, currentRound), roundCount);

  return groups
    .map((group) => {
      let asset = initialCapital;
      const carriedShares = new Map<string, number>();
      const holdings: Holding[] = [];
      const roundSummaries: RoundSummary[] = [];

      for (const round of rounds) {
        const startAsset = asset;

        if (round > activeRoundLimit) {
          roundSummaries.push({ round, startAsset, invested: 0, cash: startAsset, value: 0, profit: 0, endAsset: startAsset, overspent: 0 });
          continue;
        }

        const explicitShares = new Map(
          investments
            .filter((investment) => investment.group === group && investment.round === round && investment.company)
            .map((investment) => [investment.company, Math.max(0, investment.shares)])
        );
        const roundHoldings = companies.flatMap((company) => {
          const shares = explicitShares.has(company.name) ? explicitShares.get(company.name) ?? 0 : carriedShares.get(company.name) ?? 0;
          carriedShares.set(company.name, shares);
          if (shares <= 0) return [];

          const price = company.price ?? 0;
          const amount = shares * price;
          const rate = company?.rates[round - 1] ?? 0;
          const value = Math.round(amount * (1 + rate / 100));
          const profit = value - amount;

          return [{
            group,
            round,
            company: company.name,
            shares,
            price,
            amount,
            rate,
            value,
            profit,
            returnRate: amount ? (profit / amount) * 100 : 0
          }];
        });
        const invested = roundHoldings.reduce((total, holding) => total + holding.amount, 0);
        const overspent = Math.max(0, invested - startAsset);
        const cash = Math.max(0, startAsset - invested);
        const value = roundHoldings.reduce((total, holding) => total + holding.value, 0);
        const profit = value - invested;
        const endAsset = cash + value;

        holdings.push(...roundHoldings);
        roundSummaries.push({ round, startAsset, invested, cash, value, profit, endAsset, overspent });
        asset = endAsset;
      }

      const value = asset;
      const profit = value - initialCapital;

      return {
        investor: group,
        initialCapital,
        invested: initialCapital,
        value,
        profit,
        returnRate: initialCapital ? (profit / initialCapital) * 100 : 0,
        holdings,
        rounds: roundSummaries
      };
    })
    .sort((a, b) => b.value - a.value);
}

export function getEffectiveShares(investments: Investment[], group: string, company: string, round: number) {
  let shares = 0;

  for (const currentRound of makeRounds(round)) {
    const explicitInvestment = investments.find(
      (investment) => investment.group === group && investment.company === company && investment.round === currentRound
    );
    if (explicitInvestment) {
      shares = Math.max(0, explicitInvestment.shares);
    }
  }

  return shares;
}

export function summarize(reports: InvestorReport[]) {
  const invested = reports.reduce((total, report) => total + report.initialCapital, 0);
  const value = reports.reduce((total, report) => total + report.value, 0);
  const profit = value - invested;

  return {
    investors: reports.length,
    invested,
    value,
    profit,
    returnRate: invested ? (profit / invested) * 100 : 0,
    best: reports[0]
  };
}

export function findRate(companies: Company[], companyName: string, round: number) {
  return findCompany(companies, companyName)?.rates[round - 1] ?? 0;
}

export function findCompany(companies: Company[], companyName: string) {
  return companies.find((company) => company.name === companyName);
}
