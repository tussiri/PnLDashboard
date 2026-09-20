# City centroids (map placement only)

`city_centroids.json` maps every distinct `(JobCity, JobState)` pair found in
`sources/winteam_exports/Crane_job_master_report.csv` to an approximate city-center
coordinate:

```json
"Plano|TX": {"lat": 33.0198, "lng": -96.6989, "precision": "city_center"}
```

- Keys are `City|ST`: the city exactly as it appears in the export after `.strip()`
  (already title-cased in the source), the state upper-cased.
- Coordinates are **approximate centroids used only to place a site on the map**.
  They are not site addresses, are not geocoded from the job's street address, and
  should never be used for routing, distance or service-area calculations.
- `precision` is `city_center` when the point is the well-known center of that city or
  town (target accuracy: within a few km), or `approximate_area` when the place is an
  unincorporated community / neighborhood and the point is the nearest well-known
  center of that area (for example North Palm Springs CA, Whitsett NC, Sandston VA).
- Rows loaded from this table carry `geo_precision = 'city_center'` in `JobRow`, and the
  dashboard labels them "Approximate city center" on the map and in job facts.

`check_centroids.py` verifies that every pair in the export has an entry, that each
coordinate falls inside its state's bounding box, and prints counts by precision:

```sh
python3 sources/geo/check_centroids.py
```
