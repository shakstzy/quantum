"""Pure-parse Zillow extractors. NO HTTP, NO subprocess, NO env reads."""
from __future__ import annotations

import json
import re
from typing import Any

BASE = "https://www.zillow.com"

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)

PRIMARY_PROPERTY_PREFIXES = (
    "ForSaleShopperPlatformFullRenderQuery",
    "OffMarketShopperPlatformRenderQuery",
    "VariantQuery",
    "ForSaleDoubleScrollFullRenderQuery",
)


# ---------------------------------------------------------------------------
# HTML -> __NEXT_DATA__
# ---------------------------------------------------------------------------

def next_data(html: str) -> dict:
    m = NEXT_DATA_RE.search(html)
    if not m:
        raise RuntimeError("zillow: __NEXT_DATA__ not found; layout may have changed")
    return json.loads(m.group(1))


def search_page_state(data: dict) -> dict:
    return (((data.get("props") or {}).get("pageProps") or {})
            .get("searchPageState") or {})


def gdp_client_cache(data: dict) -> dict:
    pp = ((data.get("props") or {}).get("pageProps") or {})
    cp = pp.get("componentProps") or {}
    cache_raw = cp.get("gdpClientCache")
    if not cache_raw:
        return {}
    return json.loads(cache_raw) if isinstance(cache_raw, str) else cache_raw


# ---------------------------------------------------------------------------
# Search-list summarization
# ---------------------------------------------------------------------------

def summarize_home(h: dict) -> dict:
    hdp = h.get("hdpData") or {}
    home_info = (hdp.get("homeInfo") or {}) if isinstance(hdp, dict) else {}
    detail = h.get("detailUrl") or h.get("hdpUrl") or ""
    if detail and not detail.startswith("http"):
        detail = BASE + detail
    img_url = h.get("imgSrc") or h.get("imageSrc") or ((h.get("carouselPhotos") or [{}])[0] or {}).get("url")
    open_house = h.get("openHouse") or h.get("openHouseDescription")
    return {
        "zpid": h.get("zpid") or home_info.get("zpid"),
        "address": h.get("addressStreet") or h.get("address") or home_info.get("streetAddress"),
        "city": h.get("addressCity") or home_info.get("city"),
        "state": h.get("addressState") or home_info.get("state"),
        "zip": h.get("addressZipcode") or home_info.get("zipcode"),
        "price": h.get("unformattedPrice") or h.get("price") or home_info.get("price"),
        "beds": h.get("beds") or home_info.get("bedrooms"),
        "baths": h.get("baths") or home_info.get("bathrooms"),
        "sqft": h.get("area") or home_info.get("livingArea"),
        "lot_size": home_info.get("lotAreaValue"),
        "year_built": home_info.get("yearBuilt"),
        "url": detail,
        "status": h.get("statusType") or home_info.get("homeStatus"),
        "zestimate": home_info.get("zestimate"),
        "rent_zestimate": home_info.get("rentZestimate"),
        "tax_assessed_value": home_info.get("taxAssessedValue"),
        "home_type": home_info.get("homeType"),
        "lat": home_info.get("latitude") or (h.get("latLong") or {}).get("latitude"),
        "lng": home_info.get("longitude") or (h.get("latLong") or {}).get("longitude"),
        "image_url": img_url,
        "days_on_zillow": home_info.get("daysOnZillow"),
        "broker_name": h.get("brokerName") or home_info.get("brokerName"),
        "is_featured": h.get("isFeatured"),
        "open_house": open_house if isinstance(open_house, str) else None,
    }


def parse_search_homes(sps: dict) -> list[dict]:
    listings = ((sps.get("cat1") or {}).get("searchResults") or {}).get("listResults") or []
    return [summarize_home(h) for h in listings]


def search_total_count(sps: dict) -> int | None:
    cat1 = sps.get("cat1") or {}
    return cat1.get("totalResultCount")


def search_query_state(sps: dict) -> dict:
    return sps.get("queryState") or {}


# ---------------------------------------------------------------------------
# Property-page extraction
# ---------------------------------------------------------------------------

def find_primary_property(cache: dict) -> dict:
    """Return the property dict from the main GraphQL cache entry."""
    if not isinstance(cache, dict):
        return {}
    for k, v in cache.items():
        if any(k.startswith(p) for p in PRIMARY_PROPERTY_PREFIXES) and isinstance(v, dict) and v.get("property"):
            return v["property"]
    # fallback: first entry with a property key
    for v in cache.values():
        if isinstance(v, dict) and v.get("property"):
            return v["property"]
    return {}


def parse_property(data: dict, *, include_raw: bool = False) -> dict:
    """Extract every reasonable field from a Zillow property's __NEXT_DATA__."""
    pp = ((data.get("props") or {}).get("pageProps") or {})
    cp = pp.get("componentProps") or {}
    cache_raw = cp.get("gdpClientCache")
    if not cache_raw:
        return {"source": "zillow", "next_data_keys": list(pp.keys()),
                "raw": pp if include_raw else None}
    cache = json.loads(cache_raw) if isinstance(cache_raw, str) else cache_raw
    prop = find_primary_property(cache)
    if not isinstance(prop, dict):
        prop = {}

    def _d(v):
        """Defensive: if v is a list or non-dict, return {} so downstream
        .get() calls don't crash. Zillow's GraphQL schema occasionally
        returns lists where the previous version returned dicts."""
        return v if isinstance(v, dict) else {}

    addr = _d(prop.get("address"))
    reso = _d(prop.get("resoFacts"))
    # homeInsights is a LIST of {insights: [{phrases: [...]}]} - flatten phrases.
    insights_raw = prop.get("homeInsights") or []
    insight_phrases: list[str] = []
    if isinstance(insights_raw, list):
        for grp in insights_raw:
            if not isinstance(grp, dict):
                continue
            for insight in (grp.get("insights") or []):
                if isinstance(insight, dict):
                    for phrase in (insight.get("phrases") or []):
                        if isinstance(phrase, str) and phrase not in insight_phrases:
                            insight_phrases.append(phrase)
    insights = _d(insights_raw[0] if isinstance(insights_raw, list) and insights_raw else insights_raw)
    attribution = _d(prop.get("attributionInfo"))
    listing_provider = _d(prop.get("listingProvider"))
    photos_resp = prop.get("responsivePhotos") or prop.get("originalPhotos") or []
    photos: list[str] = []
    for p in photos_resp:
        if isinstance(p, dict):
            best = (p.get("mixedSources") or {}).get("jpeg") or []
            if best:
                photos.append(best[-1].get("url"))
            elif isinstance(p.get("url"), str):
                photos.append(p["url"])

    static_map_sources = (prop.get("staticMap") or {}).get("sources") or []
    static_map_url = (static_map_sources[0] or {}).get("url") if static_map_sources else None
    out = {
        "source": "zillow",
        "zpid": prop.get("zpid"),
        "county": prop.get("county"),
        "street_view_url": prop.get("streetViewTileImageUrlMediumAddress"),
        "static_map_url": static_map_url,
        "neighborhood_map_thumb": (prop.get("neighborhoodMapThumb") or [{}])[0].get("url") if prop.get("neighborhoodMapThumb") else None,
        "keystone_home_status": prop.get("keystoneHomeStatus"),
        "coming_soon_date": prop.get("comingSoonOnMarketDate"),
        "third_party_virtual_tour": prop.get("thirdPartyVirtualTour"),
        "mls_attribution_title": (attribution.get("attributionTitle") if isinstance(attribution, dict) else None),
        "mls_true_status": (attribution.get("trueStatus") if isinstance(attribution, dict) else None),
        "rental_applications_accepted": prop.get("rentalApplicationsAcceptedType"),
        # Phase 3: active-listing extras surfaced by the audit
        "favorite_count": prop.get("favoriteCount"),
        "page_view_count": prop.get("pageViewCount"),
        "seconds_on_zillow": prop.get("secondsOnZillow"),
        "ompd_marketing_status": prop.get("pslMarketingStatus"),
        "hdp_variant": prop.get("hdpVariant"),
        "mls_id_direct": prop.get("mlsid"),
        "affordability_estimate": _d(prop.get("affordabilityEstimate")),
        "buy_ability_data": _d(prop.get("buyAbilityData")),
        "down_payment_assistance": _d(prop.get("downPaymentAssistance")),
        "selling_soon": prop.get("sellingSoon") or [],
        "rich_media": _d(prop.get("richMedia")),
        "hi_res_image_link": prop.get("hiResImageLink"),
        "parent_region": _d(prop.get("parentRegion")),
        "city_id": prop.get("cityId"),
        "state_id": prop.get("stateId"),
        "county_id": prop.get("countyId"),
        "ouid": prop.get("ouid"),
        "ssid": prop.get("ssid"),
        "listing_account_user_id": prop.get("listingAccountUserId"),
        "date_sold_string": prop.get("dateSoldString"),
        "hide_climate_risk": prop.get("hideClimateRiskScore"),
        "third_party_virtual_tour_full": _d(prop.get("thirdPartyVirtualTour")),
        "tour_eligibility_full": _d(prop.get("tourEligibility")),
        "mortgage_zhl_rates": _d(prop.get("mortgageZHLRates")),
        "foreclosure_types": _d(prop.get("foreclosureTypes")),
        "ad_targets": _d(prop.get("adTargets")),
        "home_insights": insight_phrases,
        "address": prop.get("streetAddress") or addr.get("streetAddress"),
        "city": prop.get("city") or addr.get("city"),
        "state": prop.get("state") or addr.get("state"),
        "zip": prop.get("zipcode") or addr.get("zipcode"),
        "country": addr.get("country"),
        "lat": prop.get("latitude") or addr.get("latitude"),
        "lng": prop.get("longitude") or addr.get("longitude"),
        "price": prop.get("price"),
        "zestimate": prop.get("zestimate"),
        "rent_zestimate": prop.get("rentZestimate"),
        "zestimate_low": (prop.get("zestimateLowPercent")),
        "zestimate_high": (prop.get("zestimateHighPercent")),
        "tax_assessed_value": prop.get("taxAssessedValue"),
        "tax_history": prop.get("taxHistory") or [],
        "price_history": prop.get("priceHistory") or [],
        "value_history": prop.get("valueHistory") or [],
        "monthly_payment_estimate": prop.get("monthlyHoaFee") or insights.get("estimatedMonthlyPayment"),
        "property_tax_rate": prop.get("propertyTaxRate"),
        "annual_homeowners_insurance": prop.get("annualHomeownersInsurance"),
        "monthly_hoa_fee": prop.get("monthlyHoaFee"),
        "hoa_fee_frequency": prop.get("hoaFeeFrequency") or reso.get("hoaFeeFrequency"),
        "beds": prop.get("bedrooms"),
        "baths": prop.get("bathrooms"),
        "full_baths": reso.get("bathroomsFull"),
        "half_baths": reso.get("bathroomsHalf"),
        "sqft": prop.get("livingArea"),
        "year_built": prop.get("yearBuilt"),
        "lot_size": prop.get("lotSize"),
        "lot_area_value": prop.get("lotAreaValue"),
        "lot_area_unit": prop.get("lotAreaUnit"),
        "home_type": prop.get("homeType"),
        "home_status": prop.get("homeStatus"),
        "listing_sub_type": prop.get("listingSubType"),
        "contingent_listing_type": prop.get("contingentListingType"),
        "time_on_zillow": prop.get("timeOnZillow"),
        "date_posted": prop.get("datePosted") or prop.get("dateSoldOrPosted"),
        "date_sold": prop.get("dateSold"),
        "description": prop.get("description"),
        "schools": prop.get("schools") or [],
        "nearby_homes": prop.get("nearbyHomes") or [],
        "nearby_cities": prop.get("nearbyCities") or [],
        "nearby_neighborhoods": prop.get("nearbyNeighborhoods") or [],
        "nearby_zipcodes": prop.get("nearbyZipcodes") or [],
        "virtual_tour_url": prop.get("virtualTourUrl") or insights.get("virtualTourUrl"),
        "open_houses": prop.get("openHouseSchedule") or [],
        "parking_features": reso.get("parkingFeatures") or reso.get("parking"),
        "garage_spaces": reso.get("garageSpaces"),
        "heating": reso.get("heating"),
        "cooling": reso.get("cooling"),
        "appliances": reso.get("appliances"),
        "fireplace": reso.get("fireplaceFeatures"),
        "flooring": reso.get("flooring"),
        "stories": reso.get("stories"),
        "exterior_features": reso.get("exteriorFeatures"),
        "interior_features": reso.get("interiorFeatures"),
        "view_description": reso.get("view"),
        "pool_features": reso.get("poolFeatures"),
        "is_new_construction": reso.get("isNewConstruction"),
        "mls_id": reso.get("mlsId") or attribution.get("mlsId"),
        "mls_name": attribution.get("mlsName"),
        "listing_agent": {
            "name": attribution.get("agentName") or listing_provider.get("agentName"),
            "phone": attribution.get("agentPhoneNumber") or listing_provider.get("agentPhoneNumber"),
            "license": attribution.get("agentLicenseNumber"),
            "email": attribution.get("agentEmail"),
            "brokerage": attribution.get("brokerName") or listing_provider.get("brokerName"),
            "brokerage_phone": attribution.get("brokerPhoneNumber"),
        },
        "co_listing_agents": attribution.get("coAgentName"),
        "climate_risk": prop.get("climate") or {},
        "walk_score": (prop.get("walkScore") or {}).get("walkscore") if isinstance(prop.get("walkScore"), dict) else prop.get("walkScore"),
        "transit_score": (prop.get("transitScore") or {}).get("transit_score") if isinstance(prop.get("transitScore"), dict) else prop.get("transitScore"),
        "bike_score": (prop.get("bikeScore") or {}).get("bikescore") if isinstance(prop.get("bikeScore"), dict) else prop.get("bikeScore"),
        "photos": photos,
        "photo_count": len(photos) or None,
        "mortgage_rates": prop.get("mortgageRates"),
        "tour_eligibility": prop.get("tourEligibility"),
        "posting_product_type": prop.get("postingProductType"),
        "listing_metadata": prop.get("listingMetadata"),
    }
    if include_raw:
        out["raw"] = prop
    return out
