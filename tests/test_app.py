from fastapi.testclient import TestClient

from app.main import create_app


def login(client):
    session = client.get("/api/session").json()
    response = client.post("/api/login", json={"password": "testing-password-long"}, headers={"X-CSRF-Token": session["csrf_token"]})
    assert response.status_code == 200
    return {"X-CSRF-Token": response.json()["csrf_token"]}


def test_authentication_csrf_redaction_and_one_time_credentials(tmp_path):
    with TestClient(create_app(admin_password="testing-password-long", data_dir=tmp_path, demo=True)) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/api/settings").status_code == 401
        assert client.post("/api/login", json={"password": "testing-password-long"}).status_code == 403
        headers = login(client)
        settings = client.get("/api/settings").json()
        assert "emby_api_key" not in settings
        assert settings["emby_api_key_set"] is True
        assert client.post("/api/accounts", json={"username": "casey"}).status_code == 403
        response = client.post("/api/accounts", json={"username": "casey"}, headers=headers)
        assert response.status_code == 202
        job_id = response.json()["id"]
        import time
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] not in {"queued", "running"}:
                break
            time.sleep(0.01)
        assert job["status"] == "completed"
        assert "password" not in str(job)
        creds = client.post(f"/api/jobs/{job_id}/credentials", json={}, headers=headers).json()
        assert len(creds["credentials"]) == 1
        assert client.post(f"/api/jobs/{job_id}/credentials", json={}, headers=headers).json()["credentials"] == []
        assert client.post("/api/logout", json={}, headers=headers).status_code == 200
        assert client.get("/api/jobs").status_code == 401


def test_demo_cannot_connect_real_services(tmp_path):
    with TestClient(create_app(admin_password="testing-password-long", data_dir=tmp_path, demo=True)) as client:
        headers = login(client)
        response = client.put("/api/settings", json={"emby_url": "https://real-server.example"}, headers=headers)
        assert response.status_code == 400
        assert "read-only" in response.json()["detail"]


def test_validation_never_echoes_secret_input(tmp_path):
    with TestClient(create_app(admin_password="testing-password-long", data_dir=tmp_path, demo=True)) as client:
        session = client.get("/api/session").json()
        secret = "s" * 600
        response = client.post("/api/login", json={"password": secret}, headers={"X-CSRF-Token": session["csrf_token"]})
        assert response.status_code == 422
        assert secret not in response.text
