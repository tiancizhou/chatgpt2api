from __future__ import annotations

import uvicorn
from api import create_app

app = create_app()

if __name__ == "__main__":
    uvicorn.run(app, port=8003, access_log=False, log_level="info")
