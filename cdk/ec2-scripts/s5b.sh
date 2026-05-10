#!/bin/bash
sudo systemctl mask health-check-app
sudo systemctl stop health-check-app
sudo systemctl mask nginx
sudo systemctl stop nginx
