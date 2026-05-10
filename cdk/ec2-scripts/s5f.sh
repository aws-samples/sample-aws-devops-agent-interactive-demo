#!/bin/bash
sudo systemctl unmask nginx
sudo systemctl unmask health-check-app
sudo systemctl daemon-reload
sudo systemctl start nginx
sudo systemctl start health-check-app
