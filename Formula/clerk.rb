class Clerk < Formula
  desc "CLI for managing Clerk authentication instances"
  homepage "https://github.com/clerk/gocli"
  url "https://github.com/clerk/gocli.git",
    tag: "v0.0.4",
    revision: "df98054c7738fa04431db04712cbff612717fb9d"
  license "MIT"
  head "https://github.com/clerk/gocli.git", branch: "main"

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
