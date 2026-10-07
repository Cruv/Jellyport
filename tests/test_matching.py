from app.matching import match_items


def item(identifier, kind="Movie", providers=None, **fields):
    return {"Id": identifier, "Type": kind, "ProviderIds": providers or {}, **fields}


def test_provider_identity_ignores_title_and_id_changes():
    source = item("emby-1", providers={"IMDb": "tt42", "Tmdb": "17"}, Name="Old title")
    target = item("jellyfin-99", providers={"imdb": "TT42", "TheMovieDB": "17"}, Name="New title")
    result = match_items([source], [target])
    assert result["matches"] == [{"source": source, "target": target, "method": "provider_id"}]


def test_identical_titles_never_match_without_identity_or_path():
    source = item("s", Name="The Thing", ProductionYear=1982)
    target = item("t", Name="The Thing", ProductionYear=1982)
    result = match_items([source], [target])
    assert result["unmatched"] == [source]
    assert result["matches"] == []


def test_type_and_collection_ids_cannot_match_unrelated_items():
    source = item("s", providers={"TmdbCollection": "10", "Imdb": "tt42"})
    targets = [item("episode", "Episode", providers={"Imdb": "tt42"}), item("sequel", providers={"TmdbCollection": "10"})]
    assert match_items([source], targets)["unmatched"] == [source]


def test_episodes_match_by_series_identity_and_complete_number_range():
    source = item("s", "Episode", SeriesProviderIds={"Tvdb": "100"}, ParentIndexNumber=0, IndexNumber=1)
    first = item("t1", "Episode", SeriesProviderIds={"TheTvdb": "100"}, ParentIndexNumber=0, IndexNumber=1)
    regular_season = item("t2", "Episode", SeriesProviderIds={"Tvdb": "100"}, ParentIndexNumber=1, IndexNumber=1)
    wrong_series = item("t3", "Episode", SeriesProviderIds={"Tvdb": "200"}, ParentIndexNumber=0, IndexNumber=1)
    double_episode = item("t4", "Episode", SeriesProviderIds={"Tvdb": "100"}, ParentIndexNumber=0, IndexNumber=1, IndexNumberEnd=2)
    result = match_items([source], [first, regular_season, wrong_series, double_episode])
    assert result["matches"][0]["target"] == first
    assert result["matches"][0]["method"] == "series_episode"


def test_episode_own_provider_identity_requires_compatible_numbers():
    source = item("s", "Episode", providers={"Tvdb": "555"}, ParentIndexNumber=1, IndexNumber=1)
    target = item("t", "Episode", providers={"Tvdb": "555"}, ParentIndexNumber=1, IndexNumber=2)
    result = match_items([source], [target])
    assert result["matches"] == []
    assert result["ambiguous"][0]["candidates"] == [target]


def test_missing_episode_numbers_do_not_match_just_series_id():
    source = item("s", "Episode", SeriesProviderIds={"Tvdb": "100"}, ParentIndexNumber=1)
    target = item("t", "Episode", SeriesProviderIds={"Tvdb": "100"}, ParentIndexNumber=1)
    assert match_items([source], [target])["unmatched"] == [source]


def test_duplicate_editions_are_ambiguous_until_path_distinguishes_one():
    source = item("s", providers={"Imdb": "tt42"}, Path="/emby/film.mkv")
    first = item("t1", providers={"Imdb": "tt42"}, Path="/media/film.mkv")
    second = item("t2", providers={"Imdb": "tt42"}, Path="/media/film-4k.mkv")
    before = match_items([source], [first, second])
    assert before["ambiguous"][0]["candidates"] == [first, second]
    after = match_items([source], [first, second], [{"source": "/emby", "target": "/media"}])
    assert after["matches"][0]["target"] == first
    assert after["matches"][0]["method"] == "provider_id+path"


def test_conflicting_provider_ids_remain_ambiguous_even_with_path():
    source = item("s", providers={"Imdb": "tt42", "Tmdb": "50"}, Path="/media/film.mkv")
    first = item("t1", providers={"Imdb": "tt42", "Tmdb": "99"}, Path="/media/film.mkv")
    second = item("t2", providers={"Imdb": "tt77", "Tmdb": "50"})
    result = match_items([source], [first, second])
    assert result["matches"] == []
    assert result["ambiguous"][0]["candidates"] == [first, second]


def test_path_mapping_uses_longest_prefix_and_directory_boundaries():
    sources = [item("s1", Path="/emby/tv/a.mkv"), item("s2", Path="/emby-other/a.mkv")]
    targets = [item("t1", Path="/shows/a.mkv"), item("t2", Path="/media-other/a.mkv")]
    result = match_items(sources, targets, [
        {"source": "/emby", "target": "/media"},
        {"source": "/emby/tv", "target": "/shows"},
    ])
    assert result["matches"][0]["target"] == targets[0]
    assert result["unmatched"] == [sources[1]]


def test_exact_path_normalizes_slashes_but_preserves_case_and_inputs():
    source = item("s", Path="C:\\Media\\film.mkv")
    target = item("t", Path="/media/film.mkv")
    mappings = [{"source": "C:\\Media", "target": "/media"}]
    result = match_items([source], [target], mappings)
    assert result["matches"][0]["method"] == "path"
    assert source["Path"] == "C:\\Media\\film.mkv"
    assert mappings[0]["source"] == "C:\\Media"
    assert match_items([item("s2", Path="/Media/film.mkv")], [target])["matches"] == []


def test_duplicate_paths_are_ambiguous():
    source = item("s", Path="/media/film.mkv")
    first, second = item("t1", Path=source["Path"]), item("t2", Path=source["Path"])
    assert match_items([source], [first, second])["ambiguous"][0]["candidates"] == [first, second]
