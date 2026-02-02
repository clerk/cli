class Clerk < Formula
  desc "CLI for managing Clerk authentication instances"
  homepage "https://github.com/clerk/cli"
  url "https://github.com/clerk/cli.git",
    tag: "v0.1.1",
    revision: "1593e36685694c06f5f7b9edec2052bffe6f7f2e"
  license "MIT"
  head "https://github.com/clerk/cli.git", branch: "main"

  depends_on "go" => :build

  def install
    ldflags = "-s -w -X clerk.com/cli/internal/cmd.Version=#{version}"
    system "go", "build", *std_go_args(ldflags:), "./cmd/clerk"

    generate_completions_from_executable(bin/"clerk", "completion")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/clerk --version")
  end
end
