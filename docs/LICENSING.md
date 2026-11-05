# SignalTrail licensing

SignalTrail is a source-available platform with a permissively licensed SDK.

| Scope                                                                   | License                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| Platform, dashboard, services, tooling and other repository-owned files | FSL-1.1-ALv2, unless a more specific license applies |
| `packages/browser-sdk/`                                                 | MIT                                                  |
| `packages/contracts/`                                                   | MIT                                                  |

Each workspace package includes its applicable license. The SDK and shared
contracts can be integrated into proprietary applications under MIT; their
third-party dependencies retain their own licenses. The SDK's development-only
server fixtures do not relicense imported platform code. Bundling platform code
alongside the SDK does not make that platform code MIT.

## Platform terms

The [root license](../LICENSE.md) is the official Functional Source License 1.1
with the Apache 2.0 future license, with only its year and licensor placeholders
filled. It permits internal use, modification and other permitted purposes,
while restricting the competing commercial uses defined in the license.
It is not an OSI-approved open-source license during the restricted period.

Each version becomes available under Apache 2.0 on the second anniversary of
when that version is made available. This is per version, not a single date on
which all future releases become Apache-licensed. Copyright year is not a
release/conversion date. Preserve release history when publishing versions;
no public release or deployment is performed by adding these files.

Sources: [official FSL template](https://github.com/getsentry/fsl.software/blob/main/FSL-1.1-ALv2.template.md),
[FSL timing FAQ](https://fsl.software/), and
[MIT text](https://opensource.org/license/mit).
The actual license texts govern; this guide is an explanation.

## Third-party material and contributions

These licenses cover rights held in SignalTrail's own material. Dependencies,
container images, generated-tool notices and externally sourced material retain
their respective terms. This change is not a complete third-party provenance or
redistribution audit. Required notices must accompany any distributed artifacts.

Contributions must be offered under the applicable directory license and come
with the rights necessary to do so. No contributor agreement, copyright
assignment, or automated contributor-signoff enforcement is configured here.
Any different commercial grant or later relicensing must account for contributor
rights; a public repository alone does not transfer those rights.
