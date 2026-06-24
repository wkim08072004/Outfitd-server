# us_zips.json — attribution

Source: U.S. Census Bureau, **2024 ZIP Code Tabulation Areas (ZCTA)
Gazetteer File**, columns `GEOID`, `INTPTLAT`, `INTPTLONG`.

- https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip

**License:** U.S. Census Bureau public data, released into the public
domain. No attribution legally required, but credited here per good
citizenship.

**Coverage:** 33,791 US ZCTAs (5-digit). PO-box-only zips and other
non-tabulated zips are absent — looking them up returns 404.

**Schema:** JSON object keyed by zip string, value is `[lat, lng]`
rounded to 4 decimal places (≈ 11 m / 36 ft precision — finer than
neighborhood, coarser than building).

**Updating:** Census re-publishes the gazetteer annually. To refresh,
download the latest year's zip, extract the `.txt`, and re-run the
parser inline-documented in `lib/us_zips.js`.
