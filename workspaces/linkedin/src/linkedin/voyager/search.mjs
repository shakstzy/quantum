// Voyager people search. v0 supports the basic query+limit shape; filters can be layered later.

const SEARCH_DECO = "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-187";

export async function searchPeople(client, { query, limit = 25, start = 0 } = {}) {
  const params = {
    decorationId: SEARCH_DECO,
    q: "all",
    keywords: query,
    count: String(limit),
    start: String(start),
    origin: "GLOBAL_SEARCH_HEADER",
    queryContext: "List(spellCorrectionEnabled->true)",
    "filters": "List((key:resultType,value:List(PEOPLE)))",
  };
  const r = await client.get("/search/dash/clusters", { params, endpoint: "search_people" });
  return extractPeopleResults(r);
}

function extractPeopleResults(payload) {
  const out = [];
  const included = payload?.included ?? [];
  for (const v of included) {
    if (v?.$type !== "com.linkedin.voyager.dash.search.EntityResultViewModel"
        && v?.$type !== "com.linkedin.voyager.search.SearchHit") continue;
    const title = v?.title?.text ?? v?.actor?.name?.text ?? null;
    const subtitle = v?.primarySubtitle?.text ?? v?.secondarySubtitle?.text ?? null;
    const navigationUrl = v?.navigationUrl ?? v?.navigationContext?.url ?? null;
    const target = v?.targetUnion?.member?.entityUrn ?? v?.targetUrn ?? null;
    out.push({ title, subtitle, navigationUrl, urn: target });
  }
  return out;
}
