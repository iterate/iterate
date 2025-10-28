export const runsOn = {
  "runs-on":
    '${{ github.repository_owner == "iterate" && "depot-ubuntu-24.04-arm-4" || "ubuntu-24.04" }}',
};
