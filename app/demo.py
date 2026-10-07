"""Isolated simulated servers for a local preview; never contacts real services."""
from __future__ import annotations

import copy
import uuid

from .media import MediaError


class DemoServers:
    def __init__(self):
        self.users = {
            "emby": [{"Id": "e-alex", "Name": "alex", "Policy": {}}, {"Id": "e-river", "Name": "river", "Policy": {}}, {"Id": "e-sam", "Name": "sam", "Policy": {}}],
            "jellyfin": [{"Id": "template", "Name": "Member template", "Policy": {"IsAdministrator": False, "IsDisabled": False, "EnableAllFolders": True}, "Configuration": {"DisplayMissingEpisodes": False}}, {"Id": "j-river", "Name": "river", "Policy": {"IsAdministrator": False, "IsDisabled": False}, "Configuration": {}}],
        }
        self.media = [
            {"Id": "1", "Name": "Arrival", "Type": "Movie", "ProviderIds": {"Tmdb": "329865"}},
            {"Id": "2", "Name": "The Grand Budapest Hotel", "Type": "Movie", "ProviderIds": {"Tmdb": "120467"}},
            {"Id": "3", "Name": "The Last of Us — Pilot", "Type": "Episode", "ProviderIds": {"Tvdb": "9149826"}, "ParentIndexNumber": 1, "IndexNumber": 1},
        ]
        self.played = {"e-alex": {"1", "2", "3", "missing"}, "e-river": {"1", "2"}, "e-sam": {"3"}, "j-river": {"1"}}

    def factory(self, url, api_key, kind="jellyfin", **kwargs):
        return DemoClient(self, kind)


class DemoClient:
    def __init__(self, servers, kind):
        self.servers, self.kind = servers, kind

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def system_info(self):
        return {"ServerName": f"Demo {self.kind.title()}", "Version": "simulation"}

    async def users(self):
        return copy.deepcopy(self.servers.users[self.kind])

    async def user(self, user_id):
        return copy.deepcopy(self._user(user_id))

    def _user(self, user_id):
        for user in self.servers.users[self.kind]:
            if user["Id"] == user_id:
                return user
        raise MediaError("Demo user not found.")

    async def items(self, user_id=None):
        values = copy.deepcopy(self.servers.media)
        if self.kind == "emby":
            values += [{"Id": "missing", "Name": "An unmatched library item", "Type": "Movie", "ProviderIds": {"Tmdb": "999999999"}}]
        for value in values:
            value["UserData"] = {"Played": value["Id"] in self.servers.played.get(user_id, set())}
        return values

    async def create_user(self, name, password):
        if any(u["Name"].casefold() == name.casefold() for u in self.servers.users[self.kind]):
            raise MediaError("Demo username already exists.")
        user = {"Id": uuid.uuid4().hex, "Name": name, "Policy": {}, "Configuration": {}}
        self.servers.users[self.kind].append(user)
        return copy.deepcopy(user)

    async def set_password(self, user_id, password):
        self._user(user_id)

    async def set_policy(self, user_id, policy):
        self._user(user_id)["Policy"] = copy.deepcopy(policy)

    async def set_configuration(self, user_id, configuration):
        self._user(user_id)["Configuration"] = copy.deepcopy(configuration)

    async def mark_played(self, user_id, item_id):
        self.servers.played.setdefault(user_id, set()).add(item_id)
