# SciCat Backend - ALS Customizations

### Version: v4.x , NestJS implementation

[![Test](https://github.com/als-computing/scicat-backend-next-als/actions/workflows/test.yml/badge.svg)](https://github.com/als-computing/scicat-backend-next-als/actions/workflows/test.yml)
[![Deploy](https://github.com/als-computing/scicat-backend-next-als/actions/workflows/build-and-push.yml/badge.svg)](https://github.com/als-computing/scicat-backend-next-als/actions/workflows/build-and-push.yml)
[![Generate and upload latest SDK artifacts](https://github.com/als-computing/scicat-backend-next-als/actions/workflows/upload-sdk-artifact.yml/badge.svg?branch=master)](https://github.com/als-computing/scicat-backend-next-als/actions/workflows/upload-sdk-artifact.yml)

For more project details, head to the [official repository](https://github.com/SciCatProject/scicat-backend-next/).

## Note: This repo has a default branch of "ALS-Customizations", not the usual default of "master".

If you wish to contribute code back to the main SciCat project, merge your work to master and make the pull request from there.

Avoid merging "ALS-Customizations" into master.

### Differences between "ALS Customizations" and the official repo as of Apr 2025:

* Customizations to the OIDC authentication strategy to fetch additional user info from the ALS User Service.
* Fixes to the post-login browser redirect process (also submitted to the main project as a PR).
