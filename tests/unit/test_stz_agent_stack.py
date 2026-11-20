import aws_cdk as core
import aws_cdk.assertions as assertions

from stz_agent.stz_agent_stack import StzAgentStack

# example tests. To run these tests, uncomment this file along with the example
# resource in stz_agent/stz_agent_stack.py
def test_sqs_queue_created():
    app = core.App()
    stack = StzAgentStack(app, "stz-agent")
    template = assertions.Template.from_stack(stack)

#     template.has_resource_properties("AWS::SQS::Queue", {
#         "VisibilityTimeout": 300
#     })
